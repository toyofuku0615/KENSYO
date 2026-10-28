-- Run after migration with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql`.
-- No real user data is modified: every fixture is rolled back.
begin;
insert into auth.users(id,email,aud,role) values
 ('00000000-0000-4000-8000-000000000001','rls-a@example.invalid','authenticated','authenticated'),
 ('00000000-0000-4000-8000-000000000002','rls-b@example.invalid','authenticated','authenticated');
insert into public.users(id) values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.user_profiles(user_id,data) values
 ('00000000-0000-4000-8000-000000000001','{"ciphertext":"test-a"}'),
 ('00000000-0000-4000-8000-000000000002','{"ciphertext":"test-b"}');
insert into public.user_preferences(user_id,data) values
 ('00000000-0000-4000-8000-000000000001','{}'),('00000000-0000-4000-8000-000000000002','{}');
DO $$ declare owner_id uuid; application_id uuid; begin
 for owner_id in select id from public.users where id in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') loop
  application_id:=gen_random_uuid();
  insert into public.sources(user_id,id,data) values(owner_id,'source','{}');
  insert into public.campaigns(user_id,id,data) values(owner_id,'campaign','{"id":"campaign"}');
  insert into public.campaign_rules(user_id,campaign_id,data) values(owner_id,'campaign','{}');
  insert into public.rule_evidence(user_id,campaign_id,data) values(owner_id,'campaign','{}');
  insert into public.applications(id,user_id,campaign_id,status,data) values(application_id,owner_id,'campaign','submitted','{"status":"submitted"}');
  insert into public.application_jobs(id,user_id,campaign_id,status) values(application_id,owner_id,'campaign','submitted');
  insert into public.run_requests(user_id,kind) values(owner_id,'collect');
  insert into public.job_runs(user_id,id,data) values(owner_id,'run','{}');
  insert into public.notifications(user_id,data) values(owner_id,'{}');
  insert into public.audit_logs(user_id,data) values(owner_id,'{}');
 end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
DO $$ declare t text; visible_count integer; begin
 foreach t in array array['user_profiles','user_preferences','sources','campaigns','campaign_rules','rule_evidence','applications','application_jobs','run_requests','job_runs','notifications','audit_logs'] loop
  execute format('select count(*) from public.%I',t) into visible_count;
  if visible_count<>1 then raise exception 'RLS owner count failed for %: %',t,visible_count; end if;
  execute format('select count(*) from public.%I where user_id<>auth.uid()',t) into visible_count;
  if visible_count<>0 then raise exception 'RLS cross-owner leak in %',t; end if;
 end loop;
 if (select count(*) from public.user_profiles)<>1 then raise exception 'RLS profile count failed'; end if;
 if exists(select 1 from public.user_profiles where user_id='00000000-0000-4000-8000-000000000002') then raise exception 'RLS leaked other profile'; end if;
 if (select count(*) from public.user_preferences)<>1 then raise exception 'RLS preference count failed'; end if;
 if (select count(*) from public.users)<>1 then raise exception 'RLS users count failed'; end if;
 begin
   update public.user_profiles set data='{}';
   raise exception 'Authenticated mutation unexpectedly allowed';
 exception when insufficient_privilege then null; end;
 begin
   perform public.claim_application('00000000-0000-4000-8000-000000000002','other-campaign');
   raise exception 'Service RPC accessible to authenticated';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
DO $$ begin
 if (select data->>'ciphertext' from public.user_profiles)<>'test-b' then raise exception 'Second owner isolation failed'; end if;
end $$;
reset role;
rollback;
