-- Additive Gemini credential, budget and cache storage. No application rows change.
begin;
create table public.ai_settings (
 user_id uuid primary key references public.users(id) on delete cascade,
 data jsonb not null default '{"enabled":false,"model":"","freeTierAcknowledged":false,"dailyLimit":20,"monthlyLimit":200,"perMinuteLimit":2,"monthlyTokenLimit":100000,"maxInputChars":12000,"maxOutputTokens":1500}',
 connection jsonb not null default '{"status":"unconfigured","checkedAt":null,"error":null}',
 cooldown_until timestamptz, created_at timestamptz not null default now()
);
create table public.ai_credentials (
 user_id uuid primary key references public.users(id) on delete cascade,
 ciphertext text not null, created_at timestamptz not null default now()
);
create table public.ai_usage (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.users(id) on delete cascade,
 purpose text not null check(purpose in ('connection','models','campaign','form','answer')),model text not null,
 created_at timestamptz not null default now(),reserved_tokens bigint not null check(reserved_tokens>=0),
 input_tokens bigint not null default 0 check(input_tokens>=0),output_tokens bigint not null default 0 check(output_tokens>=0),
 success boolean,estimated boolean not null default true,error text,cooldown_until timestamptz
);
create index ai_usage_owner_date on public.ai_usage(user_id,created_at);
create table public.ai_cache (
 user_id uuid not null references public.users(id) on delete cascade,key text not null,data jsonb not null,
 expires_at timestamptz not null,created_at timestamptz not null default now(),primary key(user_id,key)
);
create table public.ai_cache_hits (
 user_id uuid not null references public.users(id) on delete cascade,month timestamptz not null,
 total bigint not null default 0,primary key(user_id,month)
);
DO $$ declare t text; begin
 foreach t in array array['ai_settings','ai_credentials','ai_usage','ai_cache','ai_cache_hits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 foreach t in array array['ai_settings','ai_usage','ai_cache_hits'] loop
  execute format('create policy owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
-- Credentials and caches intentionally have NO browser policy, even for their owner.
create function public.ai_reserve_call(p_user_id uuid,p_purpose text,p_model text,p_reserved_tokens bigint) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare pref public.ai_settings; month_start timestamptz; day_start timestamptz; total bigint; daily bigint; recent bigint; tokens bigint; result uuid;
begin
 if p_reserved_tokens<0 or p_purpose not in ('connection','models','campaign','form','answer') then raise exception 'Invalid AI reservation'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai:'||p_user_id::text,0));
 insert into public.ai_settings(user_id) values(p_user_id) on conflict(user_id) do nothing;
 select * into pref from public.ai_settings where user_id=p_user_id;
 if pref.cooldown_until>now() then return null; end if;
 day_start:=((now() at time zone 'Asia/Tokyo')::date::timestamp at time zone 'Asia/Tokyo');
 month_start:=(date_trunc('month',now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');
 select count(*),count(*) filter(where created_at>=day_start),count(*) filter(where created_at>=now()-interval '1 minute'),
 coalesce(sum(case when success is null then reserved_tokens else input_tokens+output_tokens end),0)
 into total,daily,recent,tokens from public.ai_usage where user_id=p_user_id and created_at>=month_start;
 if total>=least(greatest(coalesce((pref.data->>'monthlyLimit')::int,200),1),100000)
 or daily>=least(greatest(coalesce((pref.data->>'dailyLimit')::int,20),1),10000)
 or recent>=least(greatest(coalesce((pref.data->>'perMinuteLimit')::int,2),1),60)
 or tokens+p_reserved_tokens>least(greatest(coalesce((pref.data->>'monthlyTokenLimit')::bigint,100000),1),100000000) then return null; end if;
 insert into public.ai_usage(user_id,purpose,model,reserved_tokens) values(p_user_id,p_purpose,p_model,p_reserved_tokens) returning id into result;
 return result;
end $$;
create function public.ai_finish_call(p_user_id uuid,p_id uuid,p_result jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare reserved bigint; input_count bigint; output_count bigint; error_code text; cooldown timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('ai:'||p_user_id::text,0));
 select reserved_tokens into reserved from public.ai_usage where user_id=p_user_id and id=p_id and success is null;
 if not found then return; end if;
 input_count:=greatest(coalesce((p_result->>'inputTokens')::bigint,0),0); output_count:=greatest(coalesce((p_result->>'outputTokens')::bigint,0),0);
 if coalesce((p_result->>'estimated')::boolean,true) then input_count:=greatest(input_count,reserved); end if;
 error_code:=p_result->>'error';
 if error_code is not null and error_code !~ '^[A-Z0-9_]{1,64}$' then error_code:='AI_REQUEST_FAILED'; end if;
 cooldown:=(p_result->>'cooldownUntil')::timestamptz;
 update public.ai_usage set success=coalesce((p_result->>'success')::boolean,false),input_tokens=input_count,output_tokens=output_count,
 estimated=coalesce((p_result->>'estimated')::boolean,true),error=error_code,cooldown_until=cooldown where user_id=p_user_id and id=p_id;
 if cooldown is not null then update public.ai_settings set cooldown_until=greatest(cooldown_until,cooldown) where user_id=p_user_id; end if;
end $$;
create function public.ai_get_usage(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; month_start timestamptz; day_start timestamptz;
begin
 day_start:=((now() at time zone 'Asia/Tokyo')::date::timestamp at time zone 'Asia/Tokyo');
 month_start:=(date_trunc('month',now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');
 select jsonb_build_object('todayCalls',count(*) filter(where created_at>=day_start),'monthCalls',count(*),
 'inputTokens',coalesce(sum(case when success is null then reserved_tokens else input_tokens end),0),'outputTokens',coalesce(sum(output_tokens),0),
 'successes',count(*) filter(where success=true),'failures',count(*) filter(where success=false),
 'analysisSuccesses',count(*) filter(where success=true and purpose in ('campaign','form','answer')),
 'analysisFailures',count(*) filter(where success=false and purpose in ('campaign','form','answer')),
 'estimatedTokens',coalesce(bool_or(estimated),false))
 into result from public.ai_usage where user_id=p_user_id and created_at>=month_start;
 return result||jsonb_build_object('lastError',(select error from public.ai_usage where user_id=p_user_id and created_at>=month_start and error is not null order by created_at desc limit 1),
 'cooldownUntil',(select cooldown_until from public.ai_settings where user_id=p_user_id and cooldown_until>now()),
 'cachedHits',coalesce((select total from public.ai_cache_hits where user_id=p_user_id and month=month_start),0));
end $$;
create function public.ai_hit_cache(p_user_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.ai_cache_hits(user_id,month,total) values(p_user_id,date_trunc('month',now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo',1)
 on conflict(user_id,month) do update set total=ai_cache_hits.total+1;
end $$;
create function public.ai_reset_key_state(p_user_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.ai_settings set connection='{"status":"unconfigured","checkedAt":null,"error":null}' where user_id=p_user_id;
 delete from public.ai_cache where user_id=p_user_id;
end $$;
revoke all on function public.ai_reserve_call(uuid,text,text,bigint),public.ai_finish_call(uuid,uuid,jsonb),public.ai_get_usage(uuid),public.ai_hit_cache(uuid),public.ai_reset_key_state(uuid) from public,anon,authenticated;
grant execute on function public.ai_reserve_call(uuid,text,text,bigint),public.ai_finish_call(uuid,uuid,jsonb),public.ai_get_usage(uuid),public.ai_hit_cache(uuid),public.ai_reset_key_state(uuid) to service_role;
commit;
