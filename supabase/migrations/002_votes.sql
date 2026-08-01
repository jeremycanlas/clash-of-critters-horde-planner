-- Upvotes, and the ranking they drive. Run after 001, 001a and 001b.
--
-- One vote per Discord account per formation, enforced by the shape of the
-- table rather than by anything the client agrees to do. A ranking whose
-- constraint lives in the browser is a ranking anybody can rewrite with curl.

create table public.votes (
  formation_id uuid        not null references public.formations(id) on delete cascade,
  voter_id     uuid        not null default auth.uid()
                           references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (formation_id, voter_id)
);

alter table public.votes enable row level security;

-- You can read your own votes and nobody else's. One GET returns exactly the
-- set this account has upvoted, so the arrows can be drawn already-pressed,
-- with no way to enumerate anyone else's taste.
create policy votes_read_own on public.votes
  for select to authenticated using (voter_id = (select auth.uid()));
create policy votes_insert on public.votes
  for insert to authenticated with check (voter_id = (select auth.uid()));
create policy votes_delete_own on public.votes
  for delete to authenticated using (voter_id = (select auth.uid()));

revoke all on public.votes from anon, authenticated;
grant select (formation_id, created_at) on public.votes to authenticated;
grant insert (formation_id)             on public.votes to authenticated;
grant delete                            on public.votes to authenticated;

create index votes_voter_idx on public.votes (voter_id);

-- ---------------------------------------------------------------- self-votes
--
-- Refused. At the volumes this will actually see, a submitter's own vote is a
-- meaningful fraction of a formation's total, and a Post button that quietly
-- hands out a free point makes the number on every card mean less.

create or replace function public.refuse_self_vote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.formations f
              where f.id = new.formation_id and f.author_id = new.voter_id) then
    raise exception 'You cannot upvote your own formation' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger votes_no_self
before insert on public.votes
for each row execute function public.refuse_self_vote();

-- ---------------------------------------------------------------- the count
--
-- `score` is denormalised onto formations so that ordering a page by votes is
-- one index scan rather than a join and a group-by on every load.
--
-- security definer so it can write a column the voter has no update grant on —
-- which is the point: the number must only ever move by someone voting.

create or replace function public.bump_score()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.formations set score = score + 1 where id = new.formation_id;
    return new;
  end if;
  update public.formations set score = greatest(score - 1, 0) where id = old.formation_id;
  return old;
end;
$$;

create trigger votes_bump_score
after insert or delete on public.votes
for each row execute function public.bump_score();

-- Maintainer-only repair, for if a denormalised counter ever drifts.
create or replace function public.reconcile_scores()
returns integer language sql security definer set search_path = public as $$
  with fixed as (
    update public.formations f
       set score = coalesce((select count(*) from public.votes v where v.formation_id = f.id), 0)
     where f.score is distinct from
           coalesce((select count(*) from public.votes v where v.formation_id = f.id), 0)
    returning 1
  ) select count(*)::int from fixed;
$$;
/*
 * `from public`, NOT `from anon, authenticated`.
 *
 * Postgres grants EXECUTE on every newly created function to PUBLIC, and both
 * anon and authenticated inherit from PUBLIC. Revoking from those two roles by
 * name removes a grant they never held individually and leaves the PUBLIC one
 * standing — so this function, which is SECURITY DEFINER and returns a scalar,
 * stayed exposed as a callable RPC endpoint to anyone with the anon key.
 *
 * The trigger functions below are revoked too. PostgREST does not expose
 * functions returning `trigger`, so they were never reachable over the API, but
 * a default grant nobody intended is worth removing wherever it lands.
 */
revoke execute on function public.reconcile_scores() from public;
revoke execute on function public.refuse_self_vote() from public;
revoke execute on function public.bump_score() from public;

-- ---------------------------------------------------------------- the cards
--
-- The list now carries the whole snapshot rather than just its cells.
--
-- 001 shipped cells only, to halve the payload of the one request every visitor
-- makes. That saving turned out to cost more than it was worth: a row that
-- knows the field but not the plan advertises "4 steps" and then hands over a
-- link with no plan in it, and the preview had to fetch the rest — a second
-- request whose response could arrive after the reader had opened a different
-- formation, and put one build's link behind another build's board.
--
-- A snapshot is on the order of two kilobytes. Twenty of them is less than one
-- sprite. Carrying it removes both bugs by construction.
--
-- author_avatar joins it so a poster can be shown as themselves.

-- Dropped rather than replaced. `create or replace view` may only append
-- columns, never insert one into the middle, and author_avatar belongs beside
-- author_name rather than tacked on the end -- so replacing in place fails with
-- "cannot change name of view column". A view holds no data; dropping it costs
-- nothing but the grants, which are reissued below.
drop view if exists public.formation_cards;

create view public.formation_cards
with (security_invoker = on) as
  select id, name, note, mode, slugs, placed, steps,
         author_name, author_avatar,
         submitted_at, patch_id, score, snapshot
    from public.formations
   where not hidden;

grant select (id, name, note, snapshot, mode, slugs, placed, steps, author_name,
              author_avatar, app_version, submitted_at, patch_id, score, hidden)
  on public.formations to anon, authenticated;

grant select on public.formation_cards to anon, authenticated;

notify pgrst, 'reload schema';
