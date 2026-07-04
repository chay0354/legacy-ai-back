import { getPool } from '../db/pool.js';

export async function getOrCreateCreatorPg(userId, displayName) {
  const db = getPool();
  const existing = await db.query(
    'SELECT * FROM legacy_creators WHERE user_id = $1',
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows } = await db.query(
    `INSERT INTO legacy_creators (user_id, display_name) VALUES ($1, $2) RETURNING *`,
    [userId, displayName]
  );
  return rows[0];
}

export async function getActiveSessionPg(creatorId, stage) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM legacy_interview_sessions
     WHERE creator_id = $1 AND stage = $2 AND status = 'in_progress'
     ORDER BY created_at DESC LIMIT 1`,
    [creatorId, stage]
  );
  return rows[0] || null;
}

export async function hasProcessedSessionPg(creatorId, stage) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT 1 FROM legacy_interview_sessions
     WHERE creator_id = $1 AND stage = $2 AND status = 'processed'
     LIMIT 1`,
    [creatorId, stage]
  );
  return rows.length > 0;
}

export async function createSessionPg(creatorId, sessionNumber, label, stage = 'foundation') {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO legacy_interview_sessions (creator_id, session_number, label, stage, status)
     VALUES ($1, $2, $3, $4, 'in_progress') RETURNING *`,
    [creatorId, sessionNumber, label, stage]
  );
  return rows[0];
}

export async function countSessionsPg(creatorId) {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM legacy_interview_sessions WHERE creator_id = $1',
    [creatorId]
  );
  return rows[0].count;
}

export async function getAnswersPg(sessionId) {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT * FROM legacy_interview_answers WHERE session_id = $1 ORDER BY question_index',
    [sessionId]
  );
  return rows;
}

export async function upsertAnswerPg(sessionId, data) {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO legacy_interview_answers
      (session_id, question_index, module, category, question, answer, answer_mode, skipped)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (session_id, question_index) DO UPDATE SET
      module = EXCLUDED.module, category = EXCLUDED.category, question = EXCLUDED.question,
      answer = EXCLUDED.answer, answer_mode = EXCLUDED.answer_mode, skipped = EXCLUDED.skipped
     RETURNING *`,
    [sessionId, data.questionIndex, data.module, data.category, data.question, data.answer, data.mode, data.skipped]
  );
  return rows[0];
}

export async function completeSessionPg(sessionId, durationSeconds) {
  const db = getPool();
  await db.query(
    `UPDATE legacy_interview_sessions SET status = 'completed', completed_at = now(), duration_seconds = $2 WHERE id = $1`,
    [sessionId, durationSeconds]
  );
}

export async function saveExtractionPg(creatorId, sessionId, extracted) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (extracted.memories?.length) {
      for (const m of extracted.memories) {
        await client.query(
          `INSERT INTO legacy_memories (creator_id, session_id, title, summary, full_transcript, category, tags, people_involved, location, age, year, year_confidence, emotional_significance, lesson_learned, importance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [creatorId, sessionId, m.title, m.summary, m.full_transcript, m.category, m.tags || [], m.people_involved || [], m.location, m.age, m.year, m.year_confidence, m.emotional_significance, m.lesson_learned, m.importance || 'medium']
        );
      }
    }

    if (extracted.relationships?.length) {
      for (const r of extracted.relationships) {
        await client.query(
          `INSERT INTO legacy_relationships (creator_id, name, relationship_type, description, importance_score, influence_score, emotional_tone, relationship_summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [creatorId, r.name, r.relationship_type, r.description, r.importance_score ?? 50, r.influence_score ?? 50, r.emotional_tone, r.relationship_summary]
        );
      }
    }

    if (extracted.values?.length) {
      for (const v of extracted.values) {
        await client.query(
          `INSERT INTO legacy_values (creator_id, value_name, description, importance_score, confidence_score, supporting_stories, origin_story, is_core)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [creatorId, v.value_name, v.description, v.importance_score ?? 50, v.confidence_score ?? 50, v.supporting_stories || [], v.origin_story, v.is_core ?? false]
        );
      }
    }

    if (extracted.wisdom?.length) {
      for (const w of extracted.wisdom) {
        await client.query(
          `INSERT INTO legacy_wisdom (creator_id, title, advice_statement, life_category, supporting_story, supporting_value, confidence_score, importance_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [creatorId, w.title, w.advice_statement, w.life_category, w.supporting_story, w.supporting_value, w.confidence_score ?? 50, w.importance_score ?? 50]
        );
      }
    }

    if (extracted.threads?.length) {
      for (const t of extracted.threads) {
        await client.query(
          `INSERT INTO legacy_threads (creator_id, session_id, title, origin_statement, priority, category, status, related_people)
           VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
          [creatorId, sessionId, t.title, t.origin_statement, t.priority || 'medium', t.category, t.related_people || []]
        );
      }
    }

    if (extracted.coverage) {
      for (const [cat, score] of Object.entries(extracted.coverage)) {
        await client.query(
          `INSERT INTO legacy_coverage (creator_id, category, score, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (creator_id, category) DO UPDATE SET score = EXCLUDED.score, updated_at = now()`,
          [creatorId, cat, score]
        );
      }
    }

    if (extracted.personality) {
      await client.query(
        `INSERT INTO legacy_personality_profiles (creator_id, profile, favorite_phrases, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (creator_id) DO UPDATE SET profile = EXCLUDED.profile, favorite_phrases = EXCLUDED.favorite_phrases, updated_at = now()`,
        [creatorId, JSON.stringify(extracted.personality), extracted.personality.favorite_phrases || []]
      );
    }

    await client.query(
      `UPDATE legacy_interview_sessions SET status = 'processed', session_summary = $2, recommended_next_topics = $3 WHERE id = $1`,
      [sessionId, JSON.stringify({ text: extracted.session_summary }), JSON.stringify(extracted.recommended_next_topics || [])]
    );

    await client.query(
      `UPDATE legacy_creators SET
        avatar_level = GREATEST(avatar_level, $2),
        completion_score = GREATEST(completion_score, $3),
        updated_at = now()
       WHERE id = $1`,
      [creatorId, extracted.avatar_level ?? 1, extracted.completion_score ?? 0]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getLatestProcessedSessionPg(creatorId) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, label, stage, session_summary, completed_at
     FROM legacy_interview_sessions
     WHERE creator_id = $1 AND status = 'processed'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [creatorId]
  );
  return rows[0] || null;
}

export async function getProfilePg(creatorId) {
  const db = getPool();
  const [creator, coverage, memories, relationships, values, wisdom, threads, personality, sessions, latestSession, gallery] = await Promise.all([
    db.query('SELECT * FROM legacy_creators WHERE id = $1', [creatorId]),
    db.query('SELECT * FROM legacy_coverage WHERE creator_id = $1', [creatorId]),
    db.query(`SELECT id, title, summary, full_transcript, category, importance, lesson_learned, year, emotional_significance, people_involved
      FROM legacy_memories WHERE creator_id = $1
      ORDER BY year ASC NULLS LAST, importance DESC NULLS LAST, created_at DESC
      LIMIT 100`, [creatorId]),
    db.query(`SELECT id, name, relationship_type, description, importance_score, influence_score, emotional_tone, relationship_summary
      FROM legacy_relationships WHERE creator_id = $1 ORDER BY importance_score DESC LIMIT 12`, [creatorId]),
    db.query(`SELECT id, value_name, description, is_core, importance_score, origin_story
      FROM legacy_values WHERE creator_id = $1 ORDER BY importance_score DESC LIMIT 12`, [creatorId]),
    db.query(`SELECT id, title, advice_statement, life_category, supporting_story, supporting_value
      FROM legacy_wisdom WHERE creator_id = $1 ORDER BY importance_score DESC LIMIT 12`, [creatorId]),
    db.query(`SELECT id, title, origin_statement, priority, status FROM legacy_threads WHERE creator_id = $1 AND status = 'open' LIMIT 20`, [creatorId]),
    db.query('SELECT * FROM legacy_personality_profiles WHERE creator_id = $1', [creatorId]),
    db.query('SELECT COUNT(*)::int AS count FROM legacy_interview_sessions WHERE creator_id = $1', [creatorId]),
    getLatestProcessedSessionPg(creatorId),
    db.query(`SELECT id, image_path, caption, title, created_at
      FROM legacy_gallery_items WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 48`, [creatorId]),
  ]);

  const latestSummary = latestSession?.session_summary?.text ?? latestSession?.session_summary ?? null;

  return {
    creator: creator.rows[0],
    coverage: coverage.rows,
    memories: memories.rows,
    relationships: relationships.rows,
    values: values.rows,
    wisdom: wisdom.rows,
    openThreads: threads.rows,
    personality: personality.rows[0] || null,
    sessionCount: sessions.rows[0]?.count ?? 0,
    latestSessionSummary: typeof latestSummary === 'string' ? latestSummary : null,
    latestSessionStage: latestSession?.stage ?? null,
    latestSessionLabel: latestSession?.label ?? null,
    gallery: gallery.rows,
  };
}
