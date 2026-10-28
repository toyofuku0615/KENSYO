-- Runs after both migrations. Fixtures are rolled back, no real key is stored.
begin;
insert into auth.users(id,email,aud,role) values
 ('00000000-0000-4000-8000-000000000011','ai-a@example.invalid','authenticated','authenticated'),
 ('00000000-0000-4000-8000-000000000012','ai-b@example.invalid','authenticated','authenticated');
insert into public.users(id) values('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012');
insert into public.ai_settings(user_id) values('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012');
insert into public.ai_credentials(user_id,ciphertext) values('00000000-0000-4000-8000-000000000011','encrypted-fixture-a'),('00000000-0000-4000-8000-000000000012','encrypted-fixture-b');
insert into public.ai_cache(user_id,key,data,expires_at) values('00000000-0000-4000-8000-000000000011','cache','{}',now()+interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',true);
DO $$ begin
 if (select count(*) from public.ai_settings)<>1 then raise exception 'AI settings RLS failed'; end if;
 if exists(select 1 from public.ai_settings where user_id<>auth.uid()) then raise exception 'AI settings cross-owner leak'; end if;
 begin perform ciphertext from public.ai_credentials; raise exception 'Browser credential access allowed'; exception when insufficient_privilege then null; end;
 begin perform data from public.ai_cache; raise exception 'Browser cache access allowed'; exception when insufficient_privilege then null; end;
 begin update public.ai_settings set data='{}'; raise exception 'Browser settings update allowed'; exception when insufficient_privilege then null; end;
 begin perform public.ai_reserve_call('00000000-0000-4000-8000-000000000011','models','',0); raise exception 'Browser budget RPC allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
DO $$ declare uid uuid:='00000000-0000-4000-8000-000000000011'; bid uuid:='00000000-0000-4000-8000-000000000012'; aid uuid; usage jsonb; begin
 update public.ai_settings set data=data||'{"dailyLimit":1,"monthlyLimit":10,"perMinuteLimit":60,"monthlyTokenLimit":100}' where user_id=uid;
 aid:=public.ai_reserve_call(uid,'form','model',50);
 if aid is null then raise exception 'AI first reservation failed'; end if;
 if public.ai_reserve_call(uid,'form','model',1) is not null then raise exception 'AI daily limit bypass'; end if;
 perform public.ai_finish_call(bid,aid,'{"success":true,"inputTokens":1,"outputTokens":1,"error":null,"estimated":false}');
 if exists(select 1 from public.ai_usage where id=aid and success is not null) then raise exception 'Cross-owner AI finish allowed'; end if;
 perform public.ai_finish_call(uid,aid,jsonb_build_object('success',false,'inputTokens',0,'outputTokens',0,'error','RATE_LIMIT','estimated',true,'cooldownUntil',now()+interval '1 minute'));
 usage:=public.ai_get_usage(uid);
 if (usage->>'inputTokens')::int<>50 or (usage->>'failures')::int<>1 or (usage->>'analysisFailures')::int<>1 or (usage->>'analysisSuccesses')::int<>0 then raise exception 'AI uncertain token budget failed'; end if;
 if public.ai_reserve_call(uid,'models','',0) is not null then raise exception 'AI cooldown bypass'; end if;
 perform public.ai_hit_cache(uid);
 if (public.ai_get_usage(uid)->>'cachedHits')::int<>1 then raise exception 'AI cache metric failed'; end if;
 if (public.ai_get_usage(bid)->>'monthCalls')::int<>0 then raise exception 'AI usage cross-owner leak'; end if;
end $$;
reset role;
rollback;
