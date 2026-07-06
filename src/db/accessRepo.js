import { getPool } from './pool.js';
import { ROLES } from '../services/access.js';

/**
 * Access store: memberships + invitations. Two backends:
 *  - direct Postgres (when DATABASE_URL is set) — preferred, bypasses RLS
 *  - Supabase REST (uses the request's user client, or an admin/service client
 *    when SUPABASE_SECRET_KEY is configured — required for accepting invites).
 */
export function makeAccessStore({ supabase, admin } = {}) {
  return getPool() ? pgStore() : supabaseStore(supabase, admin);
}

/** Lookup invitation by token — works without auth (uses PG, service role, or RPC). */
export async function lookupInvitationByToken(supabase, admin, token) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query(
      `SELECT i.*, c.display_name AS creator_display_name
       FROM legacy_invitations i
       JOIN legacy_creators c ON c.id = i.creator_id
       WHERE i.token = $1`,
      [token]
    );
    return rows[0] || null;
  }

  if (admin) {
    const { data, error } = await admin
      .from('legacy_invitations')
      .select('*, legacy_creators(display_name)')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { ...data, creator_display_name: data.legacy_creators?.display_name };
  }

  const { data, error } = await supabase.rpc('legacy_invitation_by_token', { invite_token: token });
  if (error) {
    if (error.message?.includes('legacy_invitation_by_token') || error.code === 'PGRST202') {
      throw new Error(
        'Invite links need a database function. Run supabase/migrations/20250621150000_public_invite_lookup.sql in the Supabase SQL Editor.'
      );
    }
    throw error;
  }
  return data || null;
}

/* ──────────────────────────── Postgres backend ──────────────────────────── */
function pgStore() {
  const db = getPool();

  return {
    mode: 'postgres',

    async ensureOwnerMembership(creatorId, userId) {
      await db.query(
        `INSERT INTO legacy_members (creator_id, user_id, role)
         VALUES ($1, $2, 'creator')
         ON CONFLICT (creator_id, user_id) DO NOTHING`,
        [creatorId, userId]
      );
    },

    async getMembership(creatorId, userId) {
      const { rows } = await db.query(
        'SELECT * FROM legacy_members WHERE creator_id = $1 AND user_id = $2',
        [creatorId, userId]
      );
      return rows[0] || null;
    },

    async listMembershipsForUser(userId) {
      const { rows } = await db.query(
        `SELECT m.creator_id, m.role, c.display_name, c.completion_score, c.avatar_level,
                (c.user_id = m.user_id) AS is_owner
         FROM legacy_members m
         JOIN legacy_creators c ON c.id = m.creator_id
         WHERE m.user_id = $1
         ORDER BY is_owner DESC, m.created_at ASC`,
        [userId]
      );
      return rows;
    },

    async listMembers(creatorId) {
      const { rows } = await db.query(
        `SELECT m.user_id, m.role, m.created_at,
                u.email,
                COALESCE(u.raw_user_meta_data ->> 'full_name', c.display_name, u.email) AS name
         FROM legacy_members m
         LEFT JOIN auth.users u ON u.id = m.user_id
         LEFT JOIN legacy_creators c ON c.id = m.creator_id AND c.user_id = m.user_id
         WHERE m.creator_id = $1
         ORDER BY (m.role = 'creator') DESC, m.created_at ASC`,
        [creatorId]
      );
      return rows;
    },

    async createInvitation(creatorId, role, invitedBy) {
      const { rows } = await db.query(
        `INSERT INTO legacy_invitations (creator_id, email, role, invited_by)
         VALUES ($1, NULL, $2, $3) RETURNING *`,
        [creatorId, role, invitedBy]
      );
      return rows[0];
    },

    async listInvitations(creatorId) {
      const { rows } = await db.query(
        `SELECT * FROM legacy_invitations WHERE creator_id = $1 ORDER BY created_at DESC`,
        [creatorId]
      );
      return rows;
    },

    async getInvitationByToken(token) {
      const { rows } = await db.query(
        `SELECT i.*, c.display_name AS creator_display_name
         FROM legacy_invitations i
         JOIN legacy_creators c ON c.id = i.creator_id
         WHERE i.token = $1`,
        [token]
      );
      return rows[0] || null;
    },

    async listPendingInvitationsForEmail(email) {
      const { rows } = await db.query(
        `SELECT i.token, i.role, i.creator_id, c.display_name AS creator_display_name
         FROM legacy_invitations i
         JOIN legacy_creators c ON c.id = i.creator_id
         WHERE lower(i.email) = lower($1) AND i.status = 'pending' AND i.expires_at > now()`,
        [email]
      );
      return rows;
    },

    async acceptInvitation(invitation, userId) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO legacy_members (creator_id, user_id, role, invited_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (creator_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [invitation.creator_id, userId, invitation.role, invitation.invited_by]
        );
        await client.query(
          `UPDATE legacy_invitations SET status = 'accepted', accepted_by = $2 WHERE id = $1`,
          [invitation.id, userId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async revokeInvitation(id, creatorId) {
      await db.query(
        `UPDATE legacy_invitations SET status = 'revoked' WHERE id = $1 AND creator_id = $2`,
        [id, creatorId]
      );
    },

    async updateMemberRole(creatorId, userId, role) {
      await db.query(
        `UPDATE legacy_members SET role = $3 WHERE creator_id = $1 AND user_id = $2`,
        [creatorId, userId, role]
      );
    },

    async removeMember(creatorId, userId) {
      await db.query(
        `DELETE FROM legacy_members WHERE creator_id = $1 AND user_id = $2 AND role <> 'creator'`,
        [creatorId, userId]
      );
    },
  };
}

/* ──────────────────────────── Supabase backend ──────────────────────────── */
function supabaseStore(supabase, admin) {
  // Privileged client (service role) is required to write memberships for
  // invitees; fall back to the user client where RLS permits it.
  const writer = admin || supabase;

  async function emailMap(userIds) {
    const map = {};
    if (!admin || !userIds.length) return map;
    try {
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const u of data?.users || []) {
        if (userIds.includes(u.id)) {
          map[u.id] = { email: u.email, name: u.user_metadata?.full_name || u.email };
        }
      }
    } catch {
      /* admin listing unavailable — degrade gracefully */
    }
    return map;
  }

  return {
    mode: admin ? 'supabase-admin' : 'supabase',

    async ensureOwnerMembership(creatorId, userId) {
      const { data } = await supabase
        .from('legacy_members')
        .select('id')
        .eq('creator_id', creatorId)
        .eq('user_id', userId)
        .maybeSingle();
      if (data) return;
      await writer.from('legacy_members').insert({ creator_id: creatorId, user_id: userId, role: ROLES.CREATOR });
    },

    async getMembership(creatorId, userId) {
      const { data } = await writer
        .from('legacy_members')
        .select('*')
        .eq('creator_id', creatorId)
        .eq('user_id', userId)
        .maybeSingle();
      return data || null;
    },

    async listMembershipsForUser(userId) {
      const { data, error } = await supabase
        .from('legacy_members')
        .select('creator_id, role, legacy_creators(user_id, display_name, completion_score, avatar_level)')
        .eq('user_id', userId);
      if (error) throw error;
      return (data || []).map((m) => ({
        creator_id: m.creator_id,
        role: m.role,
        display_name: m.legacy_creators?.display_name,
        completion_score: m.legacy_creators?.completion_score,
        avatar_level: m.legacy_creators?.avatar_level,
        is_owner: m.legacy_creators?.user_id === userId,
      }));
    },

    async listMembers(creatorId) {
      const { data: members, error } = await supabase
        .from('legacy_members')
        .select('user_id, role, created_at')
        .eq('creator_id', creatorId);
      if (error) throw error;
      const rows = members || [];

      const { data: creator } = await supabase
        .from('legacy_creators')
        .select('user_id, display_name')
        .eq('id', creatorId)
        .maybeSingle();

      const emails = await emailMap(rows.map((r) => r.user_id));
      return rows.map((r) => {
        const fromAuth = emails[r.user_id];
        const isOwner = creator?.user_id === r.user_id;
        return {
          user_id: r.user_id,
          role: r.role,
          created_at: r.created_at,
          email: fromAuth?.email || null,
          name: fromAuth?.name || (isOwner ? creator?.display_name : null) || null,
        };
      });
    },

    async createInvitation(creatorId, role, invitedBy) {
      const { data, error } = await supabase
        .from('legacy_invitations')
        .insert({ creator_id: creatorId, role, invited_by: invitedBy })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async listInvitations(creatorId) {
      const { data, error } = await supabase
        .from('legacy_invitations')
        .select('*')
        .eq('creator_id', creatorId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },

    async getInvitationByToken(token) {
      return lookupInvitationByToken(supabase, admin, token);
    },

    async listPendingInvitationsForEmail(email) {
      const { data, error } = await supabase
        .from('legacy_invitations')
        .select('token, role, creator_id, legacy_creators(display_name)')
        .ilike('email', email)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString());
      if (error) throw error;
      return (data || []).map((i) => ({
        token: i.token,
        role: i.role,
        creator_id: i.creator_id,
        creator_display_name: i.legacy_creators?.display_name,
      }));
    },

    async acceptInvitation(invitation, userId) {
      // Preferred path: a SECURITY DEFINER RPC run as the authenticated invitee.
      // Works without the service-role key. Uses the user's own client so
      // auth.uid() inside the function resolves to the accepting user.
      const { error: rpcErr } = await supabase.rpc('legacy_accept_invitation', {
        invite_token: invitation.token,
      });

      if (!rpcErr) return;

      const missingFn =
        rpcErr.code === 'PGRST202' ||
        /legacy_accept_invitation/.test(rpcErr.message || '');

      // If the function isn't installed yet, fall back to the service-role
      // client when available; otherwise tell the user how to enable it.
      if (missingFn) {
        if (!admin) {
          throw new Error(
            'Joining needs a database function. Run supabase/migrations/20250621160000_accept_invitation_rpc.sql in the Supabase SQL Editor (or set SUPABASE_SECRET_KEY / DATABASE_URL on the server).'
          );
        }
        const { error: insErr } = await writer
          .from('legacy_members')
          .upsert(
            {
              creator_id: invitation.creator_id,
              user_id: userId,
              role: invitation.role,
              invited_by: invitation.invited_by,
            },
            { onConflict: 'creator_id,user_id' }
          );
        if (insErr) throw insErr;
        const { error: updErr } = await writer
          .from('legacy_invitations')
          .update({ status: 'accepted', accepted_by: userId })
          .eq('id', invitation.id);
        if (updErr) throw updErr;
        return;
      }

      throw new Error(rpcErr.message);
    },

    async revokeInvitation(id, creatorId) {
      const { error } = await supabase
        .from('legacy_invitations')
        .update({ status: 'revoked' })
        .eq('id', id)
        .eq('creator_id', creatorId);
      if (error) throw error;
    },

    async updateMemberRole(creatorId, userId, role) {
      const { error } = await writer
        .from('legacy_members')
        .update({ role })
        .eq('creator_id', creatorId)
        .eq('user_id', userId);
      if (error) throw error;
    },

    async removeMember(creatorId, userId) {
      const { error } = await writer
        .from('legacy_members')
        .delete()
        .eq('creator_id', creatorId)
        .eq('user_id', userId)
        .neq('role', 'creator');
      if (error) throw error;
    },
  };
}
