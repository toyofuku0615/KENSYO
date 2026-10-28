-- Service-only atomic claims and queue recovery. Every fixture is rolled back.
begin;
insert into auth.users(id,email,aud,role) values ('00000000-0000-4000-8000-000000000003','claims@example.invalid','authenticated','authenticated');
insert into public.users(id) values('00000000-0000-4000-8000-000000000003');
insert into public.user_profiles(user_id,data) values('00000000-0000-4000-8000-000000000003','{"ciphertext":"fixture"}');
insert into public.user_preferences(user_id,data) values('00000000-0000-4000-8000-000000000003',jsonb_build_object('autoApply',true,'emergencyStop',false,'consentAt',now(),'categories',jsonb_build_array('食品・飲料'),'excludedCategories','[]'::jsonb,'maxApplications',1));
set local role service_role;
select public.upsert_campaign('00000000-0000-4000-8000-000000000003',jsonb_build_object('id','claim-1','deadline',now()+interval '1 day','category','食品・飲料','rules',jsonb_build_object('evidence','[]'::jsonb)));
select public.upsert_campaign('00000000-0000-4000-8000-000000000003',jsonb_build_object('id','claim-2','deadline',now()+interval '1 day','category','食品・飲料','rules',jsonb_build_object('evidence','[]'::jsonb)));
DO $$ declare result jsonb; begin
 result:=public.claim_application('00000000-0000-4000-8000-000000000003','claim-1');
 if result is null or result->>'status'<>'submitting' then raise exception 'Initial claim failed'; end if;
 if public.claim_application('00000000-0000-4000-8000-000000000003','claim-1') is not null then raise exception 'Duplicate claim allowed'; end if;
 if public.claim_application('00000000-0000-4000-8000-000000000003','claim-2') is not null then raise exception 'Daily quota not enforced'; end if;
 begin
  perform public.save_manual_application('00000000-0000-4000-8000-000000000003','claim-1','won',1000);
  raise exception 'In-flight manual update allowed';
 exception when raise_exception then if SQLERRM<>'Application is in progress' then raise; end if; end;
end $$;
update public.applications set updated_at=now()-interval '31 minutes' where campaign_id='claim-1';
select public.reconcile_stale_applications('00000000-0000-4000-8000-000000000003');
DO $$ begin
 if (select status from public.applications where campaign_id='claim-1')<>'unknown_result' then raise exception 'Stale claim was not reconciled'; end if;
 if public.claim_application('00000000-0000-4000-8000-000000000003','claim-1') is not null then raise exception 'Unknown result resubmitted'; end if;
end $$;
insert into public.run_requests(user_id,kind) values('00000000-0000-4000-8000-000000000003','collect');
DO $$ begin
 if public.take_run_requests('00000000-0000-4000-8000-000000000003')<>'["collect"]'::jsonb then raise exception 'Queue lease failed'; end if;
 if public.take_run_requests('00000000-0000-4000-8000-000000000003')<>'[]'::jsonb then raise exception 'Concurrent lease allowed'; end if;
end $$;
update public.run_requests set lease_until=now()-interval '1 minute';
DO $$ begin
 if public.take_run_requests('00000000-0000-4000-8000-000000000003')<>'["collect"]'::jsonb then raise exception 'Expired lease not recoverable'; end if;
end $$;
reset role;
rollback;
