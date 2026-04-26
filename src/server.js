'use strict';

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const multipart = require('@fastify/multipart');
const rateLimit = require('@fastify/rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const PORT = parseInt(process.env.PORT || '10000', 10);
const HOST = '0.0.0.0';
const MAX_ZIP_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_COVER_BYTES = 2 * 1024 * 1024; // 2 MB
const UPLOAD_RATE_LIMIT_PER_IP_PER_HOUR = parseInt(
  process.env.UPLOAD_RATE_LIMIT_PER_IP_PER_HOUR || '10',
  10
);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const VALID_CATEGORIES = [
  'video',
  'image',
  'audio',
  'productivity',
  'web',
  'crypto',
  'utility',
  'other',
];
const VALID_COVER_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id serial PRIMARY KEY,
        slug text UNIQUE NOT NULL,
        name text NOT NULL,
        emoji text,
        category text NOT NULL,
        description text NOT NULL,
        author text DEFAULT 'anonymous',
        requires_env text[] DEFAULT '{}',
        zip_sha256 text,
        zip_size int,
        downloads int DEFAULT 0,
        approved boolean DEFAULT true,
        created_at timestamptz DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS skill_files (
        skill_slug text PRIMARY KEY REFERENCES skills(slug) ON DELETE CASCADE,
        data bytea NOT NULL,
        uploaded_at timestamptz DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_log (
        id serial PRIMARY KEY,
        slug text,
        author text,
        ip text,
        user_agent text,
        success boolean,
        error text,
        created_at timestamptz DEFAULT now()
      );
    `);
    // --- cover image support ---
    await client.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS cover_url TEXT;`
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS skill_covers (
        skill_slug TEXT PRIMARY KEY REFERENCES skills(slug) ON DELETE CASCADE,
        data BYTEA NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'image/png',
        uploaded_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS skills_category_idx ON skills(category);`
    );
    console.log('[migrate] schema ready');
    // Log admin-token availability once at boot (don't print the token itself).
    if (ADMIN_TOKEN) {
      console.log(
        `[admin] ADMIN_TOKEN configured (len=${ADMIN_TOKEN.length}, sha8=${crypto
          .createHash('sha256')
          .update(ADMIN_TOKEN)
          .digest('hex')
          .slice(0, 8)})`
      );
    } else {
      console.warn('[admin] ADMIN_TOKEN not set — admin endpoints are DISABLED');
    }
  } finally {
    client.release();
  }
}

function requireAdmin(req, reply) {
  if (!ADMIN_TOKEN) {
    reply.code(503).send({ error: 'admin endpoints disabled (ADMIN_TOKEN not set)' });
    return false;
  }
  const header = (req.headers['x-admin-token'] || '').toString();
  if (header !== ADMIN_TOKEN) {
    reply.code(401).send({ error: 'invalid admin token' });
    return false;
  }
  return true;
}

async function build() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: MAX_ZIP_BYTES + 1024 * 64,
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, true),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  });

  await app.register(multipart, {
    limits: {
      fileSize: MAX_ZIP_BYTES,
      files: 2, // skill zip + optional cover
      fields: 20,
    },
  });

  await app.register(rateLimit, {
    global: false,
  });

  app.get('/', async () => ({
    service: 'joniskills-api',
    version: '1.1.0',
    endpoints: [
      'GET /health',
      'GET /skills',
      'GET /skills/:slug',
      'POST /skills',
      'GET /skills/:slug/download',
      'GET /skills/:slug/cover',
      'PUT /skills/:slug/cover (admin)',
      'POST /skills/:slug/increment-download',
    ],
  }));

  app.get('/health', async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch (e) {
      return { status: 'degraded', db: 'down', error: e.message };
    }
  });

  // List skills
  app.get('/skills', async (req, reply) => {
    const category = (req.query.category || '').toString().trim();
    const params = [];
    let where = 'WHERE approved = true';
    if (category && category !== 'all') {
      if (!VALID_CATEGORIES.includes(category)) {
        return reply.code(400).send({ error: 'invalid category' });
      }
      params.push(category);
      where += ' AND category = $1';
    }
    const { rows } = await pool.query(
      `SELECT slug, name, emoji, category, description, author, requires_env,
              zip_size, downloads, cover_url, created_at
       FROM skills
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    return { skills: rows };
  });

  // Single skill
  app.get('/skills/:slug', async (req, reply) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const { rows } = await pool.query(
      `SELECT slug, name, emoji, category, description, author, requires_env,
              zip_sha256, zip_size, downloads, cover_url, created_at
       FROM skills WHERE slug = $1 AND approved = true`,
      [slug]
    );
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // Cover image (public, cached)
  app.get('/skills/:slug/cover', async (req, reply) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const { rows } = await pool.query(
      `SELECT data, content_type FROM skill_covers WHERE skill_slug = $1`,
      [slug]
    );
    if (!rows.length) return reply.code(404).send({ error: 'no cover' });
    reply
      .header('Content-Type', rows[0].content_type || 'image/png')
      .header('Cache-Control', 'public, max-age=86400')
      .send(rows[0].data);
  });

  // Admin: upsert cover for existing skill
  app.put('/skills/:slug/cover', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid slug' });

    const exists = await pool.query('SELECT 1 FROM skills WHERE slug = $1', [slug]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'skill not found' });

    let coverBuffer = null;
    let coverType = 'image/png';
    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'cover') {
          const mt = (part.mimetype || '').toLowerCase();
          if (!VALID_COVER_TYPES.has(mt)) {
            return reply.code(400).send({ error: `invalid cover content-type: ${mt}` });
          }
          coverType = mt === 'image/jpg' ? 'image/jpeg' : mt;
          const chunks = [];
          let total = 0;
          for await (const chunk of part.file) {
            total += chunk.length;
            if (total > MAX_COVER_BYTES) {
              return reply.code(413).send({ error: 'cover too large (max 2 MB)' });
            }
            chunks.push(chunk);
          }
          if (part.file.truncated) {
            return reply.code(413).send({ error: 'cover too large (max 2 MB)' });
          }
          coverBuffer = Buffer.concat(chunks, total);
        }
      }
    } catch (e) {
      return reply.code(400).send({ error: 'malformed multipart: ' + e.message });
    }
    if (!coverBuffer) {
      return reply.code(400).send({ error: "missing 'cover' file field" });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO skill_covers(skill_slug, data, content_type, uploaded_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (skill_slug)
         DO UPDATE SET data = EXCLUDED.data,
                       content_type = EXCLUDED.content_type,
                       uploaded_at = NOW()`,
        [slug, coverBuffer, coverType]
      );
      await client.query(
        `UPDATE skills SET cover_url = $2 WHERE slug = $1`,
        [slug, `/skills/${slug}/cover`]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ error: 'db error: ' + e.message });
    } finally {
      client.release();
    }
    return reply.code(200).send({
      ok: true,
      slug,
      cover_url: `/skills/${slug}/cover`,
      content_type: coverType,
      size: coverBuffer.length,
    });
  });

  // Download
  app.get('/skills/:slug/download', async (req, reply) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const { rows } = await pool.query(
      `SELECT sf.data, s.name
       FROM skill_files sf JOIN skills s ON s.slug = sf.skill_slug
       WHERE sf.skill_slug = $1 AND s.approved = true`,
      [slug]
    );
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    // increment downloads async, best-effort
    pool.query('UPDATE skills SET downloads = downloads + 1 WHERE slug = $1', [
      slug,
    ]).catch(() => {});
    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${slug}.zip"`
      )
      .send(rows[0].data);
  });

  // Increment counter only (if download happens outside backend)
  app.post('/skills/:slug/increment-download', async (req, reply) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const r = await pool.query(
      'UPDATE skills SET downloads = downloads + 1 WHERE slug = $1 RETURNING downloads',
      [slug]
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    return { downloads: r.rows[0].downloads };
  });

  // Upload
  app.post(
    '/skills',
    {
      config: {
        rateLimit: {
          max: UPLOAD_RATE_LIMIT_PER_IP_PER_HOUR,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const ip = (req.headers['x-forwarded-for'] || req.ip || '')
        .toString()
        .split(',')[0]
        .trim();
      const ua = (req.headers['user-agent'] || '').toString().slice(0, 400);

      let fields = {};
      let fileBuffer = null;
      let fileName = null;
      let coverBuffer = null;
      let coverType = 'image/png';

      try {
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            if (part.fieldname === 'file') {
              fileName = part.filename;
              const chunks = [];
              let total = 0;
              for await (const chunk of part.file) {
                total += chunk.length;
                if (total > MAX_ZIP_BYTES) {
                  return reply.code(413).send({ error: 'file too large (max 5 MB)' });
                }
                chunks.push(chunk);
              }
              if (part.file.truncated) {
                return reply.code(413).send({ error: 'file too large (max 5 MB)' });
              }
              fileBuffer = Buffer.concat(chunks, total);
            } else if (part.fieldname === 'cover') {
              const mt = (part.mimetype || '').toLowerCase();
              if (!VALID_COVER_TYPES.has(mt)) {
                return reply
                  .code(400)
                  .send({ error: `invalid cover content-type: ${mt}` });
              }
              coverType = mt === 'image/jpg' ? 'image/jpeg' : mt;
              const chunks = [];
              let total = 0;
              for await (const chunk of part.file) {
                total += chunk.length;
                if (total > MAX_COVER_BYTES) {
                  return reply
                    .code(413)
                    .send({ error: 'cover too large (max 2 MB)' });
                }
                chunks.push(chunk);
              }
              if (part.file.truncated) {
                return reply
                  .code(413)
                  .send({ error: 'cover too large (max 2 MB)' });
              }
              coverBuffer = Buffer.concat(chunks, total);
            } else {
              return reply
                .code(400)
                .send({ error: `unexpected file field: ${part.fieldname}` });
            }
          } else {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (e) {
        return reply.code(400).send({ error: 'malformed multipart: ' + e.message });
      }

      if (!fileBuffer) return reply.code(400).send({ error: 'missing file' });

      // Parse metadata: either fields.metadata (JSON string) or individual fields
      let meta = {};
      if (fields.metadata) {
        try {
          meta = JSON.parse(fields.metadata);
        } catch (e) {
          return reply.code(400).send({ error: 'invalid JSON in metadata field' });
        }
      } else {
        meta = { ...fields };
        if (typeof meta.requires_env === 'string') {
          meta.requires_env = meta.requires_env
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }

      const name = (meta.name || '').toString().trim();
      const slug = (meta.slug || '').toString().trim().toLowerCase();
      const emoji = (meta.emoji || '🔧').toString().slice(0, 16);
      const category = (meta.category || '').toString().trim().toLowerCase();
      const description = (meta.description || '').toString().trim();
      const author = (meta.author || 'anonymous').toString().trim().slice(0, 80) || 'anonymous';
      const requires_env = Array.isArray(meta.requires_env)
        ? meta.requires_env.map((s) => s.toString().trim()).filter(Boolean)
        : [];

      const logResult = async (ok, err) => {
        try {
          await pool.query(
            `INSERT INTO upload_log(slug, author, ip, user_agent, success, error)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [slug || null, author, ip, ua, ok, err || null]
          );
        } catch (_) {}
      };

      if (!name) {
        await logResult(false, 'missing name');
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!SLUG_RE.test(slug)) {
        await logResult(false, 'invalid slug');
        return reply.code(400).send({
          error: 'invalid slug (lowercase letters/digits/hyphens, 2-41 chars)',
        });
      }
      if (!VALID_CATEGORIES.includes(category)) {
        await logResult(false, 'invalid category');
        return reply.code(400).send({
          error: `category must be one of: ${VALID_CATEGORIES.join(', ')}`,
        });
      }
      if (!description || description.length < 5) {
        await logResult(false, 'description too short');
        return reply.code(400).send({ error: 'description too short' });
      }
      if (description.length > 500) {
        await logResult(false, 'description too long');
        return reply.code(400).send({ error: 'description must be ≤ 500 chars' });
      }

      // Validate zip contains SKILL.md
      let zip;
      try {
        zip = new AdmZip(fileBuffer);
      } catch (e) {
        await logResult(false, 'invalid zip');
        return reply.code(400).send({ error: 'invalid zip archive' });
      }
      const entries = zip.getEntries();
      if (!entries.length) {
        await logResult(false, 'empty zip');
        return reply.code(400).send({ error: 'zip is empty' });
      }
      // Find SKILL.md: either at root, or exactly one level deep (skill folder/SKILL.md)
      const hasSkillMd = entries.some((e) => {
        if (e.isDirectory) return false;
        const name = e.entryName.replace(/\\/g, '/');
        const parts = name.split('/');
        if (parts.length === 1 && parts[0] === 'SKILL.md') return true;
        if (parts.length === 2 && parts[1] === 'SKILL.md') return true;
        return false;
      });
      if (!hasSkillMd) {
        await logResult(false, 'missing SKILL.md');
        return reply
          .code(400)
          .send({ error: 'zip must contain SKILL.md at root of the skill folder' });
      }

      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const size = fileBuffer.length;

      // Check slug uniqueness
      const existing = await pool.query('SELECT 1 FROM skills WHERE slug = $1', [slug]);
      if (existing.rowCount) {
        await logResult(false, 'slug exists');
        return reply.code(409).send({ error: 'slug already exists' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const coverUrl = coverBuffer ? `/skills/${slug}/cover` : null;
        await client.query(
          `INSERT INTO skills(slug, name, emoji, category, description, author,
                              requires_env, zip_sha256, zip_size, approved, cover_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)`,
          [slug, name, emoji, category, description, author, requires_env, sha256, size, coverUrl]
        );
        await client.query(
          `INSERT INTO skill_files(skill_slug, data) VALUES ($1, $2)`,
          [slug, fileBuffer]
        );
        if (coverBuffer) {
          await client.query(
            `INSERT INTO skill_covers(skill_slug, data, content_type)
             VALUES ($1, $2, $3)`,
            [slug, coverBuffer, coverType]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        await logResult(false, 'db: ' + e.message);
        return reply.code(500).send({ error: 'db insert failed: ' + e.message });
      } finally {
        client.release();
      }

      await logResult(true, null);

      return reply.code(201).send({
        ok: true,
        slug,
        name,
        emoji,
        category,
        author,
        zip_size: size,
        zip_sha256: sha256,
        cover_url: coverBuffer ? `/skills/${slug}/cover` : null,
      });
    }
  );

  return app;
}

(async () => {
  try {
    await migrate();
    const app = await build();
    await app.listen({ port: PORT, host: HOST });
    console.log(`[server] listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error('[fatal]', err);
    process.exit(1);
  }
})();
