import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { makeAccessStore, lookupInvitationByToken } from '../db/accessRepo.js';
import { ROLES, can, permissionsFor } from '../services/access.js';

const router = Router();

function store(req) {
  return makeAccessStore({ supabase: req.supabase, admin: req.admin });
}

// Resolve the legacy the caller is acting on, plus their role in it.
async function resolveContext(req, explicitCreatorId) {
  const s = store(req);
  const memberships = await s.listMembershipsForUser(req.user.id);
  let creatorId = explicitCreatorId;
  if (!creatorId) {
    const owned = memberships.find((m) => m.is_owner) || memberships[0];
    creatorId = owned?.creator_id || null;
  }
  const membership = creatorId ? memberships.find((m) => m.creator_id === creatorId) : null;
  return { s, memberships, creatorId, role: membership?.role || null };
}

/** GET /api/access/me — memberships + role + pending invitations for this user */
router.get('/me', async (req, res) => {
  try {
    const s = store(req);
    const [memberships, pendingInvitations] = await Promise.all([
      s.listMembershipsForUser(req.user.id),
      req.userEmail ? s.listPendingInvitationsForEmail(req.userEmail) : [],
    ]);
    res.json({
      user: { id: req.user.id, email: req.userEmail, name: req.user.user_metadata?.full_name || null },
      memberships: memberships.map((m) => ({
        creatorId: m.creator_id,
        role: m.role,
        displayName: m.display_name,
        completionScore: m.completion_score,
        avatarLevel: m.avatar_level,
        isOwner: m.is_owner,
        permissions: permissionsFor(m.role),
      })),
      pendingInvitations: pendingInvitations.map((i) => ({
        token: i.token,
        role: i.role,
        creatorId: i.creator_id,
        creatorDisplayName: i.creator_display_name,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/access/members?creatorId= — list members (creator/admin) */
router.get('/members', async (req, res) => {
  try {
    const { s, creatorId, role } = await resolveContext(req, req.query.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'invite')) return res.status(403).json({ error: 'Not allowed to view members' });
    const members = await s.listMembers(creatorId);
    res.json({ creatorId, role, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/access/invitations?creatorId= — list invitations (creator/admin) */
router.get('/invitations', async (req, res) => {
  try {
    const { s, creatorId, role } = await resolveContext(req, req.query.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'invite')) return res.status(403).json({ error: 'Not allowed to view invitations' });
    const invitations = await s.listInvitations(creatorId);
    res.json({ creatorId, invitations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/access/invitations — { creatorId?, role } create a link-only invite */
router.post('/invitations', async (req, res) => {
  try {
    const targetRole = req.body.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.MEMBER;

    const { s, creatorId, role } = await resolveContext(req, req.body.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'invite')) return res.status(403).json({ error: 'Not allowed to invite' });
    if (targetRole === ROLES.ADMIN && !can(role, 'inviteAdmin')) {
      return res.status(403).json({ error: 'Only the creator can invite administrators' });
    }

    const invitation = await s.createInvitation(creatorId, targetRole, req.user.id);
    res.status(201).json({ invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/access/invitations/:token/accept — redeem an invitation */
router.post('/invitations/:token/accept', async (req, res) => {
  try {
    const s = store(req);
    const invitation = await s.getInvitationByToken(req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'pending') return res.status(409).json({ error: 'Invitation is no longer valid' });
    if (new Date(invitation.expires_at) < new Date()) return res.status(410).json({ error: 'Invitation has expired' });
    if (invitation.email && req.userEmail && invitation.email.toLowerCase() !== req.userEmail.toLowerCase()) {
      return res.status(403).json({ error: `This invitation was sent to ${invitation.email}. Sign in with that email to accept.` });
    }

    await s.acceptInvitation(invitation, req.user.id);
    res.json({
      success: true,
      creatorId: invitation.creator_id,
      role: invitation.role,
      creatorDisplayName: invitation.creator_display_name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/access/invitations/:id?creatorId= — revoke (creator/admin) */
router.delete('/invitations/:id', async (req, res) => {
  try {
    const { s, creatorId, role } = await resolveContext(req, req.query.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'invite')) return res.status(403).json({ error: 'Not allowed to revoke invitations' });
    await s.revokeInvitation(req.params.id, creatorId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/access/members/:userId — { creatorId?, role } change role (creator only) */
router.patch('/members/:userId', async (req, res) => {
  try {
    const newRole = req.body.role;
    if (![ROLES.ADMIN, ROLES.MEMBER].includes(newRole)) {
      return res.status(400).json({ error: 'role must be "administrator" or "member"' });
    }
    const { s, creatorId, role } = await resolveContext(req, req.body.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'manageRoles')) return res.status(403).json({ error: 'Only the creator can change roles' });

    const target = await s.getMembership(creatorId, req.params.userId);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === ROLES.CREATOR) return res.status(400).json({ error: "The creator's role cannot be changed" });

    await s.updateMemberRole(creatorId, req.params.userId, newRole);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/access/members/:userId?creatorId= — remove a member */
router.delete('/members/:userId', async (req, res) => {
  try {
    const { s, creatorId, role } = await resolveContext(req, req.query.creatorId);
    if (!creatorId) return res.status(404).json({ error: 'No legacy found' });
    if (!can(role, 'removeMembers')) return res.status(403).json({ error: 'Not allowed to remove members' });

    const target = await s.getMembership(creatorId, req.params.userId);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === ROLES.CREATOR) return res.status(400).json({ error: 'The creator cannot be removed' });
    // Administrators may only remove plain members
    if (role === ROLES.ADMIN && target.role !== ROLES.MEMBER) {
      return res.status(403).json({ error: 'Administrators can only remove members' });
    }

    await s.removeMember(creatorId, req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

/** GET /api/access/invite/:token — public preview (no auth) for join page */
export async function previewInvite(req, res) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
    );
    const admin = process.env.SUPABASE_SECRET_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;

    const invitation = await lookupInvitationByToken(supabase, admin, req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'pending') return res.status(409).json({ error: 'Invitation is no longer valid' });
    if (new Date(invitation.expires_at) < new Date()) return res.status(410).json({ error: 'Invitation has expired' });
    res.json({
      role: invitation.role,
      creatorDisplayName: invitation.creator_display_name,
      expiresAt: invitation.expires_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
