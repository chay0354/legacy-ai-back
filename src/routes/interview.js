import { Router } from 'express';
import { getPool } from '../db/pool.js';
import {
  getOrCreateCreatorPg,
  getActiveSessionPg,
  hasProcessedSessionPg,
  createSessionPg,
  countSessionsPg,
  getAnswersPg,
  upsertAnswerPg,
  completeSessionPg,
  ensureCreatorStageLevelPg,
  getProfilePg,
} from '../db/legacyRepo.js';
import { processInterviewSession } from '../services/interviewProcessor.js';
import { conductorTurn } from '../services/interviewConductor.js';
import { openAiConfigured, transcribeWhisper } from '../services/openai.js';
import { speakInterviewer, interviewerTtsConfigured } from '../services/interviewVoice.js';
import {
  buildRealtimeInstructions,
  createRealtimeCall,
  createRealtimeClientSecret,
  normalizeSessionLanguage,
} from '../services/realtimeInterview.js';
import {
  loadTopicExclusionsSupabase,
  normalizeExclusions,
  persistTopicExclusionsSupabase,
} from '../services/topicExclusions.js';
import { loadCreatorIdentity, resolveIdentity } from '../services/genderProfile.js';
import { makeAccessStore } from '../db/accessRepo.js';
import {
  resolveInterviewStage,
  getQuestionsForStage,
  getStageConfig,
  buildSessionPayload,
  nextStage,
  areAllQuestionsAnswered,
  stageCompleteLevel,
} from '../interviewStages.js';

const router = Router();
const MEDIA_BUCKET = 'legacy-media';

async function signedMediaUrl(req, path) {
  if (!path) return null;
  const { data, error } = await req.supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data.signedUrl;
}

async function ensureOwnerMembership(req, creatorId) {
  try {
    const store = makeAccessStore({ supabase: req.supabase, admin: req.admin });
    await store.ensureOwnerMembership(creatorId, req.user.id);
  } catch (err) {
    console.warn('ensureOwnerMembership failed:', err.message);
  }
}

function displayName(user) {
  return user.user_metadata?.full_name?.split(' ')[0] ||
    user.email?.split('@')[0] ||
    'Friend';
}

/** Prefer client name, else creator display_name — never invent a different identity. */
async function resolveInterviewSubjectName(req, bodyName) {
  const fromBody = String(bodyName || '').trim();
  if (fromBody) return fromBody;
  try {
    if (getPool()) {
      const creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
      const name = String(creator?.display_name || '').trim();
      if (name) return name.split(/\s+/)[0] || name;
    }
  } catch {
    /* fall through */
  }
  try {
    if (req.supabase) {
      const creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
      const name = String(creator?.display_name || '').trim();
      if (name) return name.split(/\s+/)[0] || name;
    }
  } catch {
    /* fall through */
  }
  return displayName(req.user);
}

/** Explicit gender/pronouns from profile — never inferred from name. */
async function resolveInterviewIdentity(req, body = {}) {
  const fromBody = resolveIdentity({ gender: body.gender, pronouns: body.pronouns });
  if (fromBody.gender || fromBody.pronouns) return fromBody;
  try {
    if (req.supabase) {
      const creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
      if (creator?.id) {
        const id = await loadCreatorIdentity(req.supabase, creator.id);
        return { gender: id.gender, pronouns: id.pronouns };
      }
    }
  } catch {
    /* fall through */
  }
  return { gender: null, pronouns: null };
}

function accessStore(req) {
  return makeAccessStore({ supabase: req.supabase, admin: req.admin });
}

/** Family members/admins must never start the creator interview flow. */
async function assertInterviewCreator(req) {
  const memberships = await accessStore(req).listMembershipsForUser(req.user.id);
  const ownsLegacy = memberships.some((m) => m.is_owner);
  if (ownsLegacy) return memberships;

  const { data: ownCreator } = await req.supabase
    .from('legacy_creators')
    .select('id')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (ownCreator?.id) return memberships;

  if (memberships.length > 0) {
    const err = new Error('The interview is only for people preserving their own legacy.');
    err.status = 403;
    err.code = 'FAMILY_VIEWER';
    throw err;
  }

  // No memberships yet — a new creator starting their own legacy.
  return memberships;
}

/** When no creatorId is passed, family viewers land on a shared legacy — not a new empty one. */
async function defaultCreatorIdForProfile(req, requestedCreatorId) {
  if (requestedCreatorId) return requestedCreatorId;
  const memberships = await accessStore(req).listMembershipsForUser(req.user.id);
  const shared = memberships.filter((m) => !m.is_owner);
  if (shared.length > 0) return shared[0].creator_id;
  return null;
}

async function getOrCreateCreatorSupabase(supabase, user) {
  const name = displayName(user);

  const { data, error } = await supabase.rpc('legacy_get_or_create_creator', {
    p_display_name: name,
  });

  if (!error && data) return data;

  const missingFn =
    error?.code === 'PGRST202' ||
    /legacy_get_or_create_creator/.test(error?.message || '');

  if (!missingFn) throw error;

  const { data: existing } = await supabase
    .from('legacy_creators')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from('legacy_creators')
    .insert({ user_id: user.id, display_name: name })
    .select()
    .single();

  if (insErr) throw insErr;
  return created;
}

async function hasFinishedSessionSupabase(supabase, creatorId, stage) {
  // `completed` = questionnaire finished; `processed` = extraction done.
  // Refresh must treat both as done so we never reopen a finished questionnaire.
  const { data } = await supabase
    .from('legacy_interview_sessions')
    .select('id')
    .eq('creator_id', creatorId)
    .eq('stage', stage)
    .in('status', ['completed', 'processed'])
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function ensureCreatorStageLevelSupabase(supabase, creatorId, minLevel) {
  const { data } = await supabase
    .from('legacy_creators')
    .select('avatar_level')
    .eq('id', creatorId)
    .maybeSingle();
  const current = data?.avatar_level ?? 0;
  if (current >= minLevel) return;
  const { error } = await supabase
    .from('legacy_creators')
    .update({ avatar_level: minLevel, updated_at: new Date().toISOString() })
    .eq('id', creatorId);
  if (error) throw error;
}

async function resolveStageSessionPg(creator, requestedStage) {
  let stage = resolveInterviewStage(creator, requestedStage);

  while (stage) {
    // Finished sessions win over leftover in_progress rows from older bugs.
    if (await hasProcessedSessionPg(creator.id, stage)) {
      stage = nextStage(stage);
      continue;
    }

    const active = await getActiveSessionPg(creator.id, stage);
    if (active) return { stage, session: active };

    const count = await countSessionsPg(creator.id);
    const config = getStageConfig(stage);
    const session = await createSessionPg(
      creator.id,
      count + 1,
      config.label,
      stage,
    );
    return { stage, session };
  }

  return { allComplete: true };
}

async function resolveStageSessionSupabase(supabase, creator, requestedStage) {
  let stage = resolveInterviewStage(creator, requestedStage);

  while (stage) {
    if (await hasFinishedSessionSupabase(supabase, creator.id, stage)) {
      stage = nextStage(stage);
      continue;
    }

    const { data: active } = await supabase
      .from('legacy_interview_sessions')
      .select('*')
      .eq('creator_id', creator.id)
      .eq('stage', stage)
      .eq('status', 'in_progress')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (active) return { stage, session: active };

    const { count } = await supabase
      .from('legacy_interview_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('creator_id', creator.id);

    const config = getStageConfig(stage);
    const sessionNumber = (count ?? 0) + 1;
    const { data: created, error } = await supabase
      .from('legacy_interview_sessions')
      .insert({
        creator_id: creator.id,
        session_number: sessionNumber,
        label: config.label,
        stage,
        status: 'in_progress',
      })
      .select()
      .single();

    if (error) throw error;
    return { stage, session: created };
  }

  return { allComplete: true };
}

/** If every topic is saved but status never left in_progress, mark finished so refresh won't reopen it. */
async function selfHealFullyAnsweredSession(req, { usePg, creator, stage, session, savedAnswers }) {
  const questions = getQuestionsForStage(stage);
  if (session.status !== 'in_progress') return null;
  if (!areAllQuestionsAnswered(savedAnswers, questions)) return null;

  const minLevel = stageCompleteLevel(stage);
  if (usePg) {
    await completeSessionPg(session.id, session.duration_seconds ?? null);
    await ensureCreatorStageLevelPg(creator.id, minLevel);
    const refreshed = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
    return resolveStageSessionPg(refreshed, null);
  }

  const { error } = await req.supabase
    .from('legacy_interview_sessions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', session.id);
  if (error) throw error;
  await ensureCreatorStageLevelSupabase(req.supabase, creator.id, minLevel);
  const refreshed = await getOrCreateCreatorSupabase(req.supabase, req.user);
  return resolveStageSessionSupabase(req.supabase, refreshed, null);
}

async function loadSessionMeta(supabase, pgMode, sessionId) {
  if (pgMode) {
    const db = getPool();
    const { rows } = await db.query('SELECT stage FROM legacy_interview_sessions WHERE id = $1', [sessionId]);
    return rows[0] || null;
  }
  const { data } = await supabase
    .from('legacy_interview_sessions')
    .select('stage')
    .eq('id', sessionId)
    .maybeSingle();
  return data;
}

/** GET /api/interview/session[?stage=foundation|enriched|legacy] */
router.get('/session', async (req, res) => {
  try {
    await assertInterviewCreator(req);
    const usePg = !!getPool();
    const requestedStage = req.query.stage || null;

    if (usePg) {
      let creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
      await ensureOwnerMembership(req, creator.id);

      let resolved = await resolveStageSessionPg(creator, requestedStage);
      if (resolved.allComplete) {
        return res.json({
          allStagesComplete: true,
          creator,
          stages: buildSessionPayload({ session: null, creator, stage: 'legacy', savedAnswers: [] }).stages,
          dbMode: 'postgres',
        });
      }

      let { stage, session } = resolved;
      let savedAnswers = await getAnswersPg(session.id);

      const healed = await selfHealFullyAnsweredSession(req, {
        usePg: true,
        creator,
        stage,
        session,
        savedAnswers,
      });
      if (healed?.allComplete) {
        creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
        return res.json({
          allStagesComplete: true,
          creator,
          stages: buildSessionPayload({ session: null, creator, stage: 'legacy', savedAnswers: [] }).stages,
          dbMode: 'postgres',
        });
      }
      if (healed?.session) {
        creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
        stage = healed.stage;
        session = healed.session;
        savedAnswers = await getAnswersPg(session.id);
      }

      return res.json({
        ...buildSessionPayload({ session, creator, stage, savedAnswers }),
        topicExclusions: [],
        dbMode: 'postgres',
      });
    }

    let creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
    await ensureOwnerMembership(req, creator.id);

    let resolved = await resolveStageSessionSupabase(req.supabase, creator, requestedStage);
    if (resolved.allComplete) {
      return res.json({
        allStagesComplete: true,
        creator,
        stages: buildSessionPayload({ session: null, creator, stage: 'legacy', savedAnswers: [] }).stages,
        dbMode: 'supabase',
      });
    }

    let { stage, session } = resolved;
    let { data: savedAnswers } = await req.supabase
      .from('legacy_interview_answers')
      .select('*')
      .eq('session_id', session.id)
      .order('question_index');
    savedAnswers = savedAnswers || [];

    const healed = await selfHealFullyAnsweredSession(req, {
      usePg: false,
      creator,
      stage,
      session,
      savedAnswers,
    });
    if (healed?.allComplete) {
      creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
      return res.json({
        allStagesComplete: true,
        creator,
        stages: buildSessionPayload({ session: null, creator, stage: 'legacy', savedAnswers: [] }).stages,
        dbMode: 'supabase',
      });
    }
    if (healed?.session) {
      creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
      stage = healed.stage;
      session = healed.session;
      const again = await req.supabase
        .from('legacy_interview_answers')
        .select('*')
        .eq('session_id', session.id)
        .order('question_index');
      savedAnswers = again.data || [];
    }

    const topicExclusions = await loadTopicExclusionsSupabase(req.supabase, creator.id);
    res.json({
      ...buildSessionPayload({ session, creator, stage, savedAnswers }),
      topicExclusions,
      dbMode: 'supabase',
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || undefined });
  }
});

/** PUT /api/interview/session/:sessionId/answer */
router.put('/session/:sessionId/answer', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { questionIndex, question, answer, mode, skipped } = req.body;

    if (questionIndex === undefined || !question) {
      return res.status(400).json({ error: 'questionIndex and question are required' });
    }

    const usePg = !!getPool();
    const sessionMeta = await loadSessionMeta(req.supabase, usePg, sessionId);
    const stage = sessionMeta?.stage || 'foundation';
    const questions = getQuestionsForStage(stage);
    const meta = questions[questionIndex] || {};

    if (usePg) {
      const data = await upsertAnswerPg(sessionId, {
        questionIndex,
        module: meta.module,
        category: meta.category,
        question,
        answer: answer || '',
        mode: mode || 'text',
        skipped: skipped ?? false,
      });
      return res.json({ answer: data });
    }

    const { data, error } = await req.supabase
      .from('legacy_interview_answers')
      .upsert(
        {
          session_id: sessionId,
          question_index: questionIndex,
          module: meta.module,
          category: meta.category,
          question,
          answer: answer || '',
          answer_mode: mode || 'text',
          skipped: skipped ?? false,
        },
        { onConflict: 'session_id,question_index' }
      )
      .select()
      .single();

    if (error) throw error;
    res.json({ answer: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/session/:sessionId/complete */
router.post('/session/:sessionId/complete', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { durationSeconds, answers, topicExclusions = [] } = req.body;
    const usePg = !!getPool();
    const sessionExclusions = normalizeExclusions(topicExclusions);

    const sessionMeta = await loadSessionMeta(req.supabase, usePg, sessionId);
    const stage = sessionMeta?.stage || 'foundation';
    const questions = getQuestionsForStage(stage);

    if (answers?.length) {
      for (const a of answers) {
        const meta = questions[a.questionIndex] || {};
        if (usePg) {
          await upsertAnswerPg(sessionId, {
            questionIndex: a.questionIndex,
            module: meta.module,
            category: meta.category,
            question: a.question,
            answer: a.answer || '',
            mode: a.mode || 'text',
            skipped: !a.answer?.trim(),
          });
        } else {
          await req.supabase.from('legacy_interview_answers').upsert(
            {
              session_id: sessionId,
              question_index: a.questionIndex,
              module: meta.module,
              category: meta.category,
              question: a.question,
              answer: a.answer || '',
              answer_mode: a.mode || 'text',
              skipped: !a.answer?.trim(),
            },
            { onConflict: 'session_id,question_index' }
          );
        }
      }
    }

    const minLevel = stageCompleteLevel(stage);

    if (usePg) {
      await completeSessionPg(sessionId, durationSeconds ?? null);
      const creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
      // Persist stage credit immediately so a refresh mid-extraction won't reopen this questionnaire.
      await ensureCreatorStageLevelPg(creator.id, minLevel);
      const savedAnswers = await getAnswersPg(sessionId);
      const result = await processInterviewSession({
        pgMode: true,
        sessionId,
        creatorId: creator.id,
        creatorName: creator.display_name,
        answers: savedAnswers,
        stage,
        topicExclusions: sessionExclusions,
      });
      const profile = await getProfilePg(creator.id);
      return res.json({
        success: true,
        stage,
        ...result,
        avatar_level: profile.creator?.avatar_level ?? result.avatar_level,
        completion_score: profile.creator?.completion_score ?? result.completion_score,
      });
    }

    const { error: completeErr } = await req.supabase
      .from('legacy_interview_sessions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds ?? null,
      })
      .eq('id', sessionId);

    if (completeErr) throw completeErr;

    const creator = await getOrCreateCreatorSupabase(req.supabase, req.user);
    await ensureCreatorStageLevelSupabase(req.supabase, creator.id, minLevel);
    const { data: savedAnswers } = await req.supabase
      .from('legacy_interview_answers')
      .select('*')
      .eq('session_id', sessionId)
      .order('question_index');

    if (sessionExclusions.length) {
      try {
        await persistTopicExclusionsSupabase(req.supabase, creator.id, sessionExclusions);
      } catch (e) {
        console.warn('[interview/complete] persist exclusions failed:', e.message);
      }
    }

    const result = await processInterviewSession({
      supabase: req.supabase,
      pgMode: false,
      sessionId,
      creatorId: creator.id,
      creatorName: creator.display_name,
      answers: savedAnswers,
      stage,
      topicExclusions: sessionExclusions,
    });

    const { data: freshCreator } = await req.supabase
      .from('legacy_creators')
      .select('avatar_level, completion_score')
      .eq('id', creator.id)
      .maybeSingle();

    res.json({
      success: true,
      stage,
      ...result,
      avatar_level: freshCreator?.avatar_level ?? result.avatar_level,
      completion_score: freshCreator?.completion_score ?? result.completion_score,
    });
  } catch (err) {
    console.error('Complete interview error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/interview/profile[?creatorId=]
 * Returns a legacy's extracted data. Viewable by any member of that legacy
 * (creator / administrator / member). Without creatorId, defaults to the
 * requester's own legacy (creating it on first visit).
 */
router.get('/profile', async (req, res) => {
  try {
    const store = accessStore(req);
    const requestedCreatorId = await defaultCreatorIdForProfile(req, req.query.creatorId || null);

    if (getPool()) {
      let creatorId = requestedCreatorId;
      let role;
      if (creatorId) {
        const membership = await store.getMembership(creatorId, req.user.id);
        if (!membership) return res.status(403).json({ error: 'You do not have access to this legacy' });
        role = membership.role;
      } else {
        await assertInterviewCreator(req);
        const creator = await getOrCreateCreatorPg(req.user.id, displayName(req.user));
        await ensureOwnerMembership(req, creator.id);
        creatorId = creator.id;
        role = 'creator';
      }
      const profile = await getProfilePg(creatorId);
      const gallery = await Promise.all(
        (profile.gallery || []).map(async (item) => ({
          id: item.id,
          image_path: item.image_path,
          imageUrl: await signedMediaUrl(req, item.image_path),
          caption: item.caption,
          title: item.title,
          created_at: item.created_at,
        })),
      );
      const { gallery: _galleryRows, ...profileRest } = profile;
      return res.json({ ...profileRest, gallery, role });
    }

    let creatorRow;
    let role;
    if (requestedCreatorId) {
      const membership = await store.getMembership(requestedCreatorId, req.user.id);
      if (!membership) return res.status(403).json({ error: 'You do not have access to this legacy' });
      role = membership.role;
      const { data } = await req.supabase.from('legacy_creators').select('*').eq('id', requestedCreatorId).maybeSingle();
      creatorRow = data;
    } else {
      await assertInterviewCreator(req);
      creatorRow = await getOrCreateCreatorSupabase(req.supabase, req.user);
      await ensureOwnerMembership(req, creatorRow.id);
      role = 'creator';
    }
    if (!creatorRow) return res.status(404).json({ error: 'Legacy not found' });

    const creatorId = creatorRow.id;
    const [coverage, memories, relationships, values, wisdom, threads, personality, sessions, latestSession, galleryRows] = await Promise.all([
      req.supabase.from('legacy_coverage').select('*').eq('creator_id', creatorId),
      req.supabase.from('legacy_memories').select('id, title, summary, full_transcript, category, importance, lesson_learned, year, emotional_significance, people_involved').eq('creator_id', creatorId).order('year', { ascending: true, nullsFirst: false }).order('importance', { ascending: false }).limit(100),
      req.supabase.from('legacy_relationships').select('id, name, relationship_type, description, importance_score, influence_score, emotional_tone, relationship_summary').eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(12),
      req.supabase.from('legacy_values').select('id, value_name, description, is_core, importance_score, origin_story').eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(12),
      req.supabase.from('legacy_wisdom').select('id, title, advice_statement, life_category, supporting_story, supporting_value').eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(12),
      req.supabase.from('legacy_threads').select('id, title, origin_statement, priority, status').eq('creator_id', creatorId).eq('status', 'open').limit(20),
      req.supabase.from('legacy_personality_profiles').select('*').eq('creator_id', creatorId).maybeSingle(),
      req.supabase.from('legacy_interview_sessions').select('id', { count: 'exact', head: true }).eq('creator_id', creatorId),
      req.supabase.from('legacy_interview_sessions').select('id, label, stage, session_summary, completed_at').eq('creator_id', creatorId).eq('status', 'processed').order('completed_at', { ascending: false }).limit(1).maybeSingle(),
      req.supabase.from('legacy_gallery_items').select('id, image_path, caption, title, created_at').eq('creator_id', creatorId).order('created_at', { ascending: false }).limit(48),
    ]);

    const gallery = await Promise.all(
      (galleryRows.error ? [] : (galleryRows.data || [])).map(async (item) => ({
        id: item.id,
        image_path: item.image_path,
        imageUrl: await signedMediaUrl(req, item.image_path),
        caption: item.caption,
        title: item.title,
        created_at: item.created_at,
      })),
    );

    const { data: freshCreator } = await req.supabase.from('legacy_creators').select('*').eq('id', creatorId).maybeSingle();
    const latestSummary = latestSession.data?.session_summary?.text ?? latestSession.data?.session_summary ?? null;

    res.json({
      creator: freshCreator || creatorRow,
      coverage: coverage.data || [],
      memories: memories.data || [],
      gallery,
      relationships: relationships.data || [],
      values: values.data || [],
      wisdom: wisdom.data || [],
      openThreads: threads.data || [],
      personality: personality.data || null,
      sessionCount: sessions.count ?? 0,
      latestSessionSummary: typeof latestSummary === 'string' ? latestSummary : null,
      latestSessionStage: latestSession.data?.stage ?? null,
      latestSessionLabel: latestSession.data?.label ?? null,
      role,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function assertCreatorCanEditMemories(req, creatorId) {
  if (!creatorId) throw Object.assign(new Error('creatorId required'), { status: 400 });
  const store = makeAccessStore({ supabase: req.supabase, admin: req.admin });
  const membership = await store.getMembership(creatorId, req.user.id);
  if (!membership) throw Object.assign(new Error('You do not have access to this legacy'), { status: 403 });
  if (membership.role !== 'creator') {
    throw Object.assign(new Error('Only the creator can edit this legacy'), { status: 403 });
  }
  return creatorId;
}

/** POST /api/interview/gallery — upload metadata after image stored in legacy-media */
router.post('/gallery', async (req, res) => {
  try {
    const { creatorId, imagePath, caption, title } = req.body || {};
    const resolvedCreatorId = await assertCreatorCanEditMemories(req, creatorId);

    if (!imagePath?.trim()) return res.status(400).json({ error: 'imagePath required' });
    if (!caption?.trim()) return res.status(400).json({ error: 'caption required' });

    const row = {
      creator_id: resolvedCreatorId,
      image_path: imagePath.trim(),
      caption: caption.trim(),
      title: title?.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await req.supabase
      .from('legacy_gallery_items')
      .insert(row)
      .select('id, image_path, caption, title, created_at')
      .single();

    if (error) throw error;

    const imageUrl = await signedMediaUrl(req, data.image_path);
    res.status(201).json({ item: { ...data, imageUrl } });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Create gallery item error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

/** DELETE /api/interview/gallery/:id */
router.delete('/gallery/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await req.supabase
      .from('legacy_gallery_items')
      .select('id, creator_id, image_path')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Gallery item not found' });

    await assertCreatorCanEditMemories(req, existing.creator_id);

    const { error } = await req.supabase.from('legacy_gallery_items').delete().eq('id', id);
    if (error) throw error;

    await req.supabase.storage.from(MEDIA_BUCKET).remove([existing.image_path]).catch(() => {});

    res.json({ success: true, id });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Delete gallery item error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

/** POST /api/interview/memories — manually add a memory from the legacy home */
router.post('/memories', async (req, res) => {
  try {
    const { creatorId, title, summary, year, category } = req.body || {};
    const resolvedCreatorId = await assertCreatorCanEditMemories(req, creatorId);

    if (!title?.trim() || !summary?.trim()) {
      return res.status(400).json({ error: 'title and summary required' });
    }

    const row = {
      creator_id: resolvedCreatorId,
      title: title.trim(),
      summary: summary.trim(),
      full_transcript: summary.trim(),
      year: year?.trim() || null,
      category: category?.trim() || 'story',
      importance: 'medium',
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await req.supabase
      .from('legacy_memories')
      .insert(row)
      .select('id, title, summary, category, year, importance')
      .single();

    if (error) throw error;
    res.status(201).json({ memory: data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Create memory error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

/** PATCH /api/interview/memories/:id */
router.patch('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, year, category } = req.body || {};

    const { data: existing, error: fetchErr } = await req.supabase
      .from('legacy_memories')
      .select('id, creator_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Memory not found' });

    await assertCreatorCanEditMemories(req, existing.creator_id);

    const patch = { updated_at: new Date().toISOString() };
    if (title !== undefined) patch.title = String(title).trim() || null;
    if (summary !== undefined) {
      const text = String(summary).trim();
      patch.summary = text;
      patch.full_transcript = text;
    }
    if (year !== undefined) patch.year = String(year).trim() || null;
    if (category !== undefined) patch.category = String(category).trim() || 'story';

    const { data, error } = await req.supabase
      .from('legacy_memories')
      .update(patch)
      .eq('id', id)
      .select('id, title, summary, category, year, importance')
      .single();

    if (error) throw error;
    res.json({ memory: data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Update memory error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

/** DELETE /api/interview/memories/:id */
router.delete('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await req.supabase
      .from('legacy_memories')
      .select('id, creator_id, title')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Memory not found' });

    await assertCreatorCanEditMemories(req, existing.creator_id);

    const { error } = await req.supabase.from('legacy_memories').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, id });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('Delete memory error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

/** GET /api/interview/voice/status */
router.get('/voice/status', (_req, res) => {
  res.json({
    available: openAiConfigured(),
    realtime: openAiConfigured(),
    whisper: openAiConfigured(),
    tts: interviewerTtsConfigured(),
    ttsProvider: process.env.INTERVIEWER_TTS_PROVIDER || 'elevenlabs',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
  });
});

/** POST /api/interview/voice/realtime/token — ephemeral key for browser WebRTC (recommended) */
router.post('/voice/realtime/token', async (req, res) => {
  try {
    if (!openAiConfigured()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    }
    const {
      subjectName,
      stage,
      anchorQuestion,
      digFor = '',
      questionIndex = 0,
      totalQuestions = 1,
      priorTopics = [],
      topicExclusions = [],
      language = 'en',
    } = req.body || {};

    if (!anchorQuestion) return res.status(400).json({ error: 'anchorQuestion required' });

    const resolvedName = await resolveInterviewSubjectName(req, subjectName);
    const identity = await resolveInterviewIdentity(req, req.body || {});
    const secret = await createRealtimeClientSecret({
      subjectName: resolvedName,
      stage: stage || 'foundation',
      anchorQuestion,
      digFor,
      questionIndex,
      totalQuestions,
      priorTopics,
      topicExclusions: normalizeExclusions(topicExclusions),
      language: normalizeSessionLanguage(language),
      gender: identity.gender,
      pronouns: identity.pronouns,
      isOpening: Number(questionIndex) === 0,
    });

    res.json(secret);
  } catch (err) {
    console.error('Realtime token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/voice/realtime/session — WebRTC SDP exchange (OpenAI Realtime API) */
router.post('/voice/realtime/session', async (req, res) => {
  try {
    if (!openAiConfigured()) {
      return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    }
    const {
      sdp,
      subjectName,
      stage,
      anchorQuestion,
      digFor = '',
      questionIndex = 0,
      totalQuestions = 1,
      priorTopics = [],
      topicExclusions = [],
      language = 'en',
    } = req.body || {};

    if (typeof sdp !== 'string' || !sdp.trim()) return res.status(400).json({ error: 'sdp required' });
    if (sdp.trim().length < 100) {
      return res.status(400).json({ error: `SDP too short (${sdp.trim().length} chars) — wait for ICE gathering` });
    }
    if (!anchorQuestion) return res.status(400).json({ error: 'anchorQuestion required' });

    const resolvedName = await resolveInterviewSubjectName(req, subjectName);
    const identity = await resolveInterviewIdentity(req, req.body || {});
    const answerSdp = await createRealtimeCall(sdp, {
      subjectName: resolvedName,
      stage: stage || 'foundation',
      anchorQuestion,
      digFor,
      questionIndex,
      totalQuestions,
      priorTopics,
      topicExclusions: normalizeExclusions(topicExclusions),
      language: normalizeSessionLanguage(language),
      gender: identity.gender,
      pronouns: identity.pronouns,
      isOpening: Number(questionIndex) === 0,
    });

    res.type('application/sdp').send(answerSdp);
  } catch (err) {
    console.error('Realtime session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/voice/realtime/instructions — updated prompt for next anchor question */
router.post('/voice/realtime/instructions', async (req, res) => {
  try {
    const {
      subjectName,
      stage,
      anchorQuestion,
      digFor = '',
      questionIndex = 0,
      totalQuestions = 1,
      priorTopics = [],
      topicExclusions = [],
      language = 'en',
    } = req.body || {};

    if (!anchorQuestion) return res.status(400).json({ error: 'anchorQuestion required' });

    const resolvedName = await resolveInterviewSubjectName(req, subjectName);
    const identity = await resolveInterviewIdentity(req, req.body || {});
    res.json({
      instructions: buildRealtimeInstructions({
        subjectName: resolvedName,
        stage: stage || 'foundation',
        anchorQuestion,
        digFor,
        questionIndex,
        totalQuestions,
        priorTopics,
        topicExclusions: normalizeExclusions(topicExclusions),
        language: normalizeSessionLanguage(language),
        gender: identity.gender,
        pronouns: identity.pronouns,
        isOpening: Number(questionIndex) === 0,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/voice/transcribe — body: { audio: base64, mimeType? } */
router.post('/voice/transcribe', async (req, res) => {
  try {
    if (!openAiConfigured()) {
      return res.status(503).json({ error: 'Voice interview is not available right now.' });
    }
    const { audio, mimeType = 'audio/webm' } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio required' });

    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType.includes('mp4') ? 'audio.m4a' : 'audio.webm';
    const text = await transcribeWhisper(buffer, ext);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/voice/speak — body: { text } → audio/mpeg */
router.post('/voice/speak', async (req, res) => {
  try {
    if (!interviewerTtsConfigured()) {
      return res.status(503).json({ error: 'Interviewer voice not configured' });
    }
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });

    const mp3 = await speakInterviewer(text.trim());
    res.set('Content-Type', 'audio/mpeg');
    res.send(mp3);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/interview/voice/turn — AI interviewer reply */
router.post('/voice/turn', async (req, res) => {
  try {
    const {
      subjectName,
      stage,
      anchorQuestion,
      digFor = '',
      questionIndex = 0,
      totalQuestions = 1,
      turns = [],
      userTranscript = '',
      isOpening = false,
      topicExclusions = [],
      language = 'en',
    } = req.body || {};

    if (!anchorQuestion) return res.status(400).json({ error: 'anchorQuestion required' });

    const resolvedName = await resolveInterviewSubjectName(req, subjectName);
    const identity = await resolveInterviewIdentity(req, req.body || {});
    const result = await conductorTurn({
      subjectName: resolvedName,
      stage: stage || 'foundation',
      anchorQuestion,
      digFor,
      questionIndex,
      totalQuestions,
      gender: identity.gender,
      pronouns: identity.pronouns,
      turns,
      userTranscript,
      isOpening: Boolean(isOpening),
      topicExclusions: normalizeExclusions(topicExclusions),
      language: normalizeSessionLanguage(language),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
