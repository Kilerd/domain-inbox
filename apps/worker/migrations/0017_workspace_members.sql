-- Shared inbox: every user belongs to the owner's workspace, and all mail,
-- domains, rules and send quota stay keyed by the workspace owner's user id.
-- Sessions and push devices remain keyed by the individual user id.
--
-- Members previously saw an empty inbox because every query filtered on their
-- own user id. Existing members are pointed at the single workspace owner;
-- rows they may have created before this migration are folded back in.

ALTER TABLE users ADD COLUMN workspace_owner_id TEXT REFERENCES users(id);

UPDATE users
SET workspace_owner_id = (
  SELECT id FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1
)
WHERE role <> 'owner';

UPDATE users SET workspace_owner_id = id WHERE role = 'owner' AND workspace_owner_id IS NULL;

-- API keys minted by a member before the workspace change should keep working
-- against the shared domains. Other member-owned mail rows did not exist
-- before shared inbox support (members saw no domains), so only keys move.
UPDATE api_keys
SET owner_id = (SELECT u.workspace_owner_id FROM users u WHERE u.id = api_keys.owner_id)
WHERE owner_id IN (
  SELECT id FROM users WHERE workspace_owner_id IS NOT NULL AND workspace_owner_id <> id
);
