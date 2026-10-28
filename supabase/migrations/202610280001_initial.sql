-- Apply through Supabase SQL editor or `supabase db push`.
begin;
create extension if not exists pgcrypto;
create table public.users (
 id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table public.user_profiles (
 user_id uuid primary key references public.users(id) on delete cascade,
 data jsonb not null, created_at timestamptz not null default now()
);
create table public.user_preferences (
 user_id uuid primary key references public.users(id) on delete cascade,
 data jsonb not null, created_at timestamptz not null default now()
);
create table public.sources (
 user_id uuid not null references public.users(id) on delete cascade,
 id text not null, data jsonb not null, created_at timestamptz not null default now(), primary key(user_id,id)
);
create table public.campaigns (
 user_id uuid not null references public.users(id) on delete cascade,
 id text not null, data jsonb not null, created_at timestamptz not null default now(), primary key(user_id,id),
 check(data->>'id'=id)
);
create index campaigns_deadline_idx on public.campaigns(user_id,(data->>'deadline'));
create table public.campaign_rules (
 user_id uuid not null, campaign_id text not null, data jsonb not null,
 created_at timestamptz not null default now(), primary key(user_id,campaign_id),
 foreign key(user_id,campaign_id) references public.campaigns(user_id,id) on delete cascade
);
create table public.rule_evidence (
 user_id uuid not null, campaign_id text not null, id uuid primary key default gen_random_uuid(), data jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(user_id,campaign_id) references public.campaigns(user_id,id) on delete cascade
);
create table public.submission_adapters (
 id text primary key, data jsonb not null, created_at timestamptz not null default now()
);
insert into public.submission_adapters(id,data) values ('fixture','{"name":"ローカル検証フォーム","testOnly":true}');
create table public.applications (
 id uuid not null unique default gen_random_uuid(), user_id uuid not null, campaign_id text not null,
 status text not null check(status in ('discovered','eligible','ready_to_submit','submitting','submitted','manual_required','blocked','failed','unknown_result','expired','won','lost')),
 data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(user_id,campaign_id), foreign key(user_id,campaign_id) references public.campaigns(user_id,id) on delete cascade,
 check(data->>'status'=status)
);
create index applications_owner_date_idx on public.applications(user_id,created_at);
create index applications_stale_idx on public.applications(updated_at) where status='submitting';
create table public.application_jobs (
 id uuid primary key references public.applications(id) on delete cascade,
 user_id uuid not null references public.users(id) on delete cascade,
 campaign_id text not null, status text not null, created_at timestamptz not null default now(),
 foreign key(user_id,campaign_id) references public.campaigns(user_id,id) on delete cascade,
 unique(user_id,campaign_id)
);
create table public.run_requests (
 user_id uuid not null references public.users(id) on delete cascade,
 kind text not null check(kind in ('collect','apply')), lease_until timestamptz,
 created_at timestamptz not null default now(), primary key(user_id,kind)
);
create table public.job_runs (
 user_id uuid not null references public.users(id) on delete cascade, id text not null, data jsonb not null,
 created_at timestamptz not null default now(), primary key(user_id,id)
);
create table public.notifications (
 user_id uuid not null references public.users(id) on delete cascade, id uuid primary key default gen_random_uuid(), data jsonb not null,
 created_at timestamptz not null default now()
);
create table public.audit_logs (
 user_id uuid not null references public.users(id) on delete cascade, id uuid primary key default gen_random_uuid(), data jsonb not null,
 created_at timestamptz not null default now()
);
create index audit_logs_owner_date_idx on public.audit_logs(user_id,created_at);

-- All mutation goes through authenticated server routes and the service-role worker.
-- Browser clients may only read their own records. No authenticated role can forge
-- submitted states, edit encrypted profile fields, or bypass the atomic claim RPC.
alter table public.users enable row level security;
create policy users_read_own on public.users for select to authenticated using(id=auth.uid());
revoke all on public.users from anon,authenticated;
grant select on public.users to authenticated;
grant all on public.users to service_role;
DO $$ declare t text; begin
 foreach t in array array['user_profiles','user_preferences','sources','campaigns','campaign_rules','rule_evidence','applications','application_jobs','run_requests','job_runs','notifications','audit_logs'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('create policy owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
   execute format('revoke all on public.%I from anon,authenticated',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
alter table public.submission_adapters enable row level security;
create policy adapter_read on public.submission_adapters for select to authenticated using(true);
revoke all on public.submission_adapters from anon,authenticated;
grant select on public.submission_adapters to authenticated;
grant all on public.submission_adapters to service_role;

create function public.upsert_campaign(p_user_id uuid,p_campaign jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare evidence jsonb;
begin
 insert into public.campaigns(user_id,id,data) values(p_user_id,p_campaign->>'id',p_campaign)
 on conflict(user_id,id) do update set data=excluded.data || jsonb_build_object('discoveredAt',coalesce(campaigns.data->'discoveredAt',excluded.data->'discoveredAt'));
 insert into public.campaign_rules(user_id,campaign_id,data) values(p_user_id,p_campaign->>'id',p_campaign->'rules')
 on conflict(user_id,campaign_id) do update set data=excluded.data;
 delete from public.rule_evidence where user_id=p_user_id and campaign_id=p_campaign->>'id';
 for evidence in select value from jsonb_array_elements(coalesce(p_campaign#>'{rules,evidence}','[]')) loop
   insert into public.rule_evidence(user_id,campaign_id,data) values(p_user_id,p_campaign->>'id',evidence);
 end loop;
end $$;

create function public.claim_application(p_user_id uuid,p_campaign_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare pref jsonb; campaign jsonb; result jsonb; aid uuid:=gen_random_uuid(); today_start timestamptz; total integer;
begin
 -- Serializes a user's daily quota and all campaigns. Unique owner/campaign is a
 -- second independent barrier; a persisted claim is never automatically retried.
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 select data into pref from public.user_preferences where user_id=p_user_id;
 select data into campaign from public.campaigns where user_id=p_user_id and id=p_campaign_id;
 if pref is null or campaign is null then return null; end if;
 if not coalesce((pref->>'autoApply')::boolean,false) or coalesce((pref->>'emergencyStop')::boolean,true)
 or pref->>'consentAt' is null or (pref->>'consentAt')::timestamptz>now()
 or not exists(select 1 from public.user_profiles where user_id=p_user_id) then return null; end if;
 if (campaign->>'deadline')::timestamptz<=now()
 or (campaign->>'startsAt' is not null and (campaign->>'startsAt')::timestamptz>now())
 or not coalesce((pref->'categories') ? (campaign->>'category'),false)
 or coalesce((pref->'excludedCategories') ? (campaign->>'category'),false) then return null; end if;
 today_start := ((now() at time zone 'Asia/Tokyo')::date::timestamp at time zone 'Asia/Tokyo');
 select count(*) into total from public.applications where user_id=p_user_id and created_at>=today_start;
 if total>=least(greatest(coalesce((pref->>'maxApplications')::integer,0),0),100) then return null; end if;
 if exists(select 1 from public.applications where user_id=p_user_id and campaign_id=p_campaign_id) then return null; end if;
 result:=jsonb_build_object('id',aid,'campaignId',p_campaign_id,'status','submitting','receipt',null,'error',null,'createdAt',now(),'updatedAt',now(),'prizeValue',null);
 insert into public.applications(id,user_id,campaign_id,status,data) values(aid,p_user_id,p_campaign_id,'submitting',result);
 insert into public.application_jobs(id,user_id,campaign_id,status) values(aid,p_user_id,p_campaign_id,'submitting');
 insert into public.audit_logs(user_id,data) values(p_user_id,jsonb_build_object('action','application.claimed','campaignId',p_campaign_id,'detail','排他制御により応募権を確保','createdAt',now()));
 return result;
end $$;

create function public.reconcile_stale_applications(p_user_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.applications set status='unknown_result',updated_at=now(),data=data||jsonb_build_object('status','unknown_result','updatedAt',now(),'error','ワーカー中断後の結果不明。自動再送しません。')
 where user_id=p_user_id and status='submitting' and updated_at<now()-interval '30 minutes';
 update public.application_jobs j set status='unknown_result' from public.applications a
 where a.user_id=p_user_id and j.user_id=a.user_id and j.id=a.id and a.status='unknown_result';
end $$;

create function public.save_manual_application(p_user_id uuid,p_campaign_id text,p_status text,p_prize_value numeric default 0) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare current_app public.applications; result jsonb; aid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 if p_status not in ('submitted','won','lost') or p_prize_value<0 then raise exception 'Invalid outcome'; end if;
 if not exists(select 1 from public.campaigns where user_id=p_user_id and id=p_campaign_id) then raise exception 'Campaign not found'; end if;
 select * into current_app from public.applications where user_id=p_user_id and campaign_id=p_campaign_id;
 if current_app.status='submitting' then raise exception 'Application is in progress'; end if;
 aid:=coalesce(current_app.id,gen_random_uuid());
 result:=jsonb_build_object('id',aid,'campaignId',p_campaign_id,'status',p_status,'receipt',current_app.data->>'receipt','error',null,'createdAt',coalesce(current_app.created_at,now()),'updatedAt',now(),'prizeValue',case when p_status='won' then p_prize_value else null end);
 insert into public.applications(id,user_id,campaign_id,status,data) values(aid,p_user_id,p_campaign_id,p_status,result)
 on conflict(user_id,campaign_id) do update set status=excluded.status,data=excluded.data,updated_at=now();
 insert into public.audit_logs(user_id,data) values(p_user_id,jsonb_build_object('action','application.manual','campaignId',p_campaign_id,'detail',p_status,'createdAt',now()));
end $$;

create function public.take_run_requests(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 with claimed as (update public.run_requests set lease_until=now()+interval '30 minutes' where user_id=p_user_id and (lease_until is null or lease_until<=now()) returning kind)
 select coalesce(jsonb_agg(kind),'[]'::jsonb) into result from claimed;
 return result;
end $$;

revoke all on function public.upsert_campaign(uuid,jsonb), public.claim_application(uuid,text), public.reconcile_stale_applications(uuid), public.save_manual_application(uuid,text,text,numeric), public.take_run_requests(uuid) from public,anon,authenticated;
grant execute on function public.upsert_campaign(uuid,jsonb), public.claim_application(uuid,text), public.reconcile_stale_applications(uuid), public.save_manual_application(uuid,text,text,numeric), public.take_run_requests(uuid) to service_role;
commit;
