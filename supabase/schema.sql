-- 絕地求生 雲端存檔 — Supabase 結構
-- 於 Supabase Dashboard → SQL Editor 執行一次即可。
--
-- 安全模型：
--   資料表啟用 RLS 且沒有任何 policy → anon key 無法直接讀寫資料表。
--   所有存取都經過下列 SECURITY DEFINER 函式，並以 token（由帳號密碼反覆雜湊而來）驗證。

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

-- ============================================================
-- 多人世界：玩家自願公開的據點與探索隊伍（v2.0.0）
-- ============================================================
create table if not exists public.jdqs_world (
  id          text primary key check (id ~ '^[0-9a-f]{32}$'),
  token_hash  text not null,
  lat         double precision not null,   -- 主要據點位置（附近查詢用）
  lon         double precision not null,
  payload     jsonb not null,              -- { name, civ, bases[], trips[] }
  updated_at  bigint not null
);
create index if not exists jdqs_world_pos on public.jdqs_world (lat, lon);
alter table public.jdqs_world enable row level security;
revoke all on public.jdqs_world from anon, authenticated;

create or replace function public.jdqs_world_put(p_id text, p_token text, p_payload jsonb, p_lat double precision, p_lon double precision)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
begin
  if p_id !~ '^[0-9a-f]{32}$' or p_token !~ '^[0-9a-f]{64}$' then return json_build_object('status', 'forbidden'); end if;
  if octet_length(p_payload::text) > 32768 then raise exception 'payload too large'; end if;
  select * into s from public.jdqs_world where id = p_id for update;
  if found and s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  insert into public.jdqs_world (id, token_hash, lat, lon, payload, updated_at)
    values (p_id, p_token, p_lat, p_lon, p_payload, (extract(epoch from clock_timestamp()) * 1000)::bigint)
    on conflict (id) do update set lat = excluded.lat, lon = excluded.lon, payload = excluded.payload, updated_at = excluded.updated_at;
  return json_build_object('status', 'ok');
end $$;

create or replace function public.jdqs_world_delete(p_id text, p_token text)
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from public.jdqs_world where id = p_id and token_hash = p_token;
  return json_build_object('status', 'ok');
end $$;

-- 附近玩家（以主要據點位置判斷，排除 3 天未更新者）
create or replace function public.jdqs_world_nearby(p_lat double precision, p_lon double precision, p_km double precision, p_exclude text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('status', 'ok', 'players', coalesce(json_agg(p.payload || jsonb_build_object('id', p.id, 'updatedAt', p.updated_at)), '[]'::json))
  from (
    select * from public.jdqs_world
    where id <> coalesce(p_exclude, '')
      and abs(lat - p_lat) <= least(p_km, 20) / 111.32
      and abs(lon - p_lon) <= least(p_km, 20) / (111.32 * greatest(cos(radians(p_lat)), 0.1))
      and updated_at > (extract(epoch from clock_timestamp()) * 1000)::bigint - 3 * 86400000
    limit 100
  ) p;
$$;

revoke all on function public.jdqs_world_put(text, text, jsonb, double precision, double precision) from public;
revoke all on function public.jdqs_world_delete(text, text) from public;
revoke all on function public.jdqs_world_nearby(double precision, double precision, double precision, text) from public;
grant execute on function public.jdqs_world_put(text, text, jsonb, double precision, double precision) to anon, authenticated;
grant execute on function public.jdqs_world_delete(text, text) to anon, authenticated;
grant execute on function public.jdqs_world_nearby(double precision, double precision, double precision, text) to anon, authenticated;

-- ============================================================
-- 玩家之間的事件信箱（v7.0.0）：攻擊、友好請求、接受、解除
-- 已經建立過的專案只要再執行一次本檔即可（皆為 if not exists / or replace）
-- ============================================================
create table if not exists public.jdqs_world_events (
  id         bigserial primary key,
  to_id      text not null,
  from_id    text not null,
  from_name  text not null,
  type       text not null,
  data       jsonb not null default '{}'::jsonb,
  at         bigint not null
);
create index if not exists jdqs_world_events_to on public.jdqs_world_events (to_id);
alter table public.jdqs_world_events enable row level security;
revoke all on public.jdqs_world_events from anon, authenticated;

create or replace function public.jdqs_world_send(p_from text, p_token text, p_to text, p_type text, p_data jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
begin
  if p_type not in ('attack', 'friendRequest', 'friendAccept', 'friendRemove', 'intercept', 'plunder') or p_from = p_to then
    return json_build_object('status', 'invalid');
  end if;
  if octet_length(coalesce(p_data, '{}'::jsonb)::text) > 2000 then return json_build_object('status', 'invalid'); end if;
  select * into s from public.jdqs_world where id = p_from;
  if not found or s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  if not exists (select 1 from public.jdqs_world where id = p_to) then return json_build_object('status', 'notfound'); end if;
  insert into public.jdqs_world_events (to_id, from_id, from_name, type, data, at)
    values (p_to, p_from, coalesce(s.payload->>'name', '倖存者'), p_type, coalesce(p_data, '{}'::jsonb), (extract(epoch from clock_timestamp()) * 1000)::bigint);
  -- 每位玩家最多保留 50 筆
  delete from public.jdqs_world_events where to_id = p_to and id not in (
    select id from public.jdqs_world_events where to_id = p_to order by id desc limit 50);
  return json_build_object('status', 'ok');
end $$;

create or replace function public.jdqs_world_inbox(p_id text, p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
declare out json;
begin
  select * into s from public.jdqs_world where id = p_id;
  if not found then return json_build_object('status', 'ok', 'events', '[]'::json); end if;
  if s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  select coalesce(json_agg(json_build_object('from', from_id, 'fromName', from_name, 'type', type, 'data', data, 'at', at) order by id), '[]'::json)
    into out from public.jdqs_world_events where to_id = p_id;
  delete from public.jdqs_world_events where to_id = p_id;
  return json_build_object('status', 'ok', 'events', out);
end $$;

revoke all on function public.jdqs_world_send(text, text, text, text, jsonb) from public;
revoke all on function public.jdqs_world_inbox(text, text) from public;
grant execute on function public.jdqs_world_send(text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.jdqs_world_inbox(text, text) to anon, authenticated;
