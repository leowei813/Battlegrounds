-- 絕地求生 雲端存檔 — Supabase 結構
-- 於 Supabase Dashboard → SQL Editor 執行一次即可。
--
-- 安全模型：
--   資料表啟用 RLS 且沒有任何 policy → anon key 無法直接讀寫資料表。
--   所有存取都經過下列 SECURITY DEFINER 函式，並以 token（同步碼的 SHA-256）驗證。

create table if not exists public.jdqs_saves (
  id          text primary key check (id ~ '^[0-9a-f]{32}$'),
  token_hash  text not null,
  rev         integer not null default 1,
  device_id   text,
  device_name text,
  data        jsonb not null,
  updated_at  bigint not null
);
alter table public.jdqs_saves enable row level security;
revoke all on public.jdqs_saves from anon, authenticated;

create or replace function public.jdqs_meta_json(s public.jdqs_saves)
returns json language sql immutable as $$
  select json_build_object('rev', s.rev, 'updatedAt', s.updated_at, 'deviceId', s.device_id, 'deviceName', s.device_name);
$$;

create or replace function public.jdqs_save_meta(p_id text, p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_saves;
begin
  select * into s from public.jdqs_saves where id = p_id;
  if not found then return json_build_object('status', 'notfound'); end if;
  if s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  return json_build_object('status', 'ok', 'meta', public.jdqs_meta_json(s));
end $$;

create or replace function public.jdqs_save_get(p_id text, p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_saves;
begin
  select * into s from public.jdqs_saves where id = p_id;
  if not found then return json_build_object('status', 'notfound'); end if;
  if s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  return json_build_object('status', 'ok', 'meta', public.jdqs_meta_json(s), 'data', s.data);
end $$;

create or replace function public.jdqs_save_put(
  p_id text, p_token text, p_base_rev integer, p_device_id text, p_device_name text, p_data jsonb, p_force boolean default false
) returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_saves;
declare now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if p_id !~ '^[0-9a-f]{32}$' or p_token !~ '^[0-9a-f]{64}$' then
    return json_build_object('status', 'forbidden');
  end if;
  if octet_length(p_data::text) > 2 * 1024 * 1024 then
    raise exception 'payload too large';
  end if;
  select * into s from public.jdqs_saves where id = p_id for update;
  if not found then
    if p_base_rev <> 0 and not p_force then
      return json_build_object('status', 'conflict', 'meta', json_build_object('rev', 0));
    end if;
    insert into public.jdqs_saves (id, token_hash, rev, device_id, device_name, data, updated_at)
      values (p_id, p_token, 1, left(p_device_id, 64), left(p_device_name, 64), p_data, now_ms)
      returning * into s;
    return json_build_object('status', 'ok', 'meta', public.jdqs_meta_json(s));
  end if;
  if s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  if not p_force and p_base_rev <> s.rev then
    return json_build_object('status', 'conflict', 'meta', public.jdqs_meta_json(s));
  end if;
  update public.jdqs_saves
     set rev = s.rev + 1, device_id = left(p_device_id, 64), device_name = left(p_device_name, 64),
         data = p_data, updated_at = now_ms
   where id = p_id
   returning * into s;
  return json_build_object('status', 'ok', 'meta', public.jdqs_meta_json(s));
end $$;

revoke all on function public.jdqs_save_meta(text, text) from public;
revoke all on function public.jdqs_save_get(text, text) from public;
revoke all on function public.jdqs_save_put(text, text, integer, text, text, jsonb, boolean) from public;
grant execute on function public.jdqs_save_meta(text, text) to anon, authenticated;
grant execute on function public.jdqs_save_get(text, text) to anon, authenticated;
grant execute on function public.jdqs_save_put(text, text, integer, text, text, jsonb, boolean) to anon, authenticated;
