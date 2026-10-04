-- =============================================================================
-- NEXUS - delete an announcement outright
-- Migration : 20260927000042_delete_announcement.sql
-- Purpose   : Give the console a Delete, beside the Retire it already has.
--
-- WHY RETIRE ALONE WAS NOT ENOUGH
--
-- The Announcements tab offers Retire, which is the correct default: a notice a
-- participant has already read does not stop existing because it was hidden, and
-- retire keeps the row for the audit trail.
--
-- But retire only took OFF a published notice, so an announcement that was never
-- published had no way off the list at all. Those are the typos, the half-typed
-- experiments and the "clicked save before I was ready" rows, and leaving them to
-- accumulate is how the tab becomes a list nobody reads.
--
-- MASTER ONLY, and deliberately a separate capability from writing one. The
-- console's existing split is the model: retire_contact and retire_destination are
-- admin+, while delete_destination is master-only and the UI says "delete" only
-- where the database's staff_at_least('master') check will agree. Widen one
-- without the other and the UI starts offering a button the server refuses.
--
-- The audit row is written BEFORE the delete, from the values already read, so the
-- record of what was published outlives the row itself.
-- =============================================================================

create or replace function public.staff_delete_announcement (p_announcement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title   text;
  v_pinned  boolean;
  v_created timestamptz;
begin
  -- THE gate, and it is master's alone. An admin may retire; only a master may
  -- erase, which is the same distinction the catalogue makes.
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can permanently delete an announcement.');
  end if;

  select a.title, a.is_pinned, a.created_at
    into v_title, v_pinned, v_created
    from public.announcements a
   where a.id = p_announcement_id;

  if v_title is null then
    return jsonb_build_object('ok', false, 'error', 'No such announcement.');
  end if;

  -- Audited first: after the DELETE the title is gone, and the point of the audit
  -- trail is that it still says what was there.
  perform public.staff_audit(
    'delete_announcement', 'announcement', p_announcement_id::text,
    jsonb_build_object('title', v_title, 'pinned', v_pinned, 'created_at', v_created)
  );

  delete from public.announcements where id = p_announcement_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such announcement.');
  end if;

  return jsonb_build_object('ok', true, 'id', p_announcement_id);
end;
$$;

comment on function public.staff_delete_announcement(uuid) is
  'MASTER ONLY. Removes the row entirely, for an announcement that should never have existed - a typo, a half-typed experiment, a notice saved before it was ready. Retire (staff_retire_announcement, admin+) is the right action for anything that was published and should come DOWN; it keeps the row and the audit trail. This one does not. Audited before the delete, from values read beforehand.';

revoke execute on function public.staff_delete_announcement(uuid) from public;
grant  execute on function public.staff_delete_announcement(uuid) to anon, authenticated;