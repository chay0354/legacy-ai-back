/**
 * User types & permissions for Legacy AI.
 *
 *  creator        — the person whose legacy is preserved. Full control: edits
 *                   content, manages their profile, appoints administrators,
 *                   invites users.
 *  administrator  — usually a trusted child / family member. Invites users,
 *                   manages access, views content, chats with the avatar.
 *                   CANNOT edit/delete the creator's memories or profile, and
 *                   cannot appoint other administrators.
 *  member         — invited family member. Views content and chats with the
 *                   avatar. Cannot edit content, manage access, or invite.
 *
 * Access is invitation-only: there is no public access by default.
 */
export const ROLES = {
  CREATOR: 'creator',
  ADMIN: 'administrator',
  MEMBER: 'member',
};

export const ROLE_LIST = [ROLES.CREATOR, ROLES.ADMIN, ROLES.MEMBER];

const PERMISSIONS = {
  creator: {
    view: true,
    chat: true,
    interview: true,
    editContent: true,
    manageProfile: true,
    invite: true,
    inviteAdmin: true,
    manageRoles: true,
    removeMembers: true,
  },
  administrator: {
    view: true,
    chat: true,
    interview: false,
    editContent: false,
    manageProfile: false,
    invite: true,
    inviteAdmin: false,
    manageRoles: false,
    removeMembers: true,
  },
  member: {
    view: true,
    chat: true,
    interview: false,
    editContent: false,
    manageProfile: false,
    invite: false,
    inviteAdmin: false,
    manageRoles: false,
    removeMembers: false,
  },
};

export function can(role, action) {
  return !!PERMISSIONS[role]?.[action];
}

export function permissionsFor(role) {
  return { ...(PERMISSIONS[role] || PERMISSIONS.member) };
}

const ROLE_RANK = {
  [ROLES.CREATOR]: 3,
  [ROLES.ADMIN]: 2,
  [ROLES.MEMBER]: 1,
};

/** Keep the higher-privilege role when re-accepting a different invite for the same legacy. */
export function higherRole(existing, incoming) {
  const a = ROLE_RANK[existing] || 0;
  const b = ROLE_RANK[incoming] || 0;
  return a >= b ? existing : incoming;
}
