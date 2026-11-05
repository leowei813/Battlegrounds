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
  if p_type not in ('attack', 'friendRequest', 'friendAccept', 'friendRemove', 'intercept', 'plunder', 'tradeBuy', 'tradeEnd', 'tradeRefund', 'demandSell', 'demandPay', 'demandReturn') or p_from = p_to then
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

-- ============================================================
-- 共用世界物件（v9.0.0）：NPC、殭屍群、黑市、交易市場、重度感染據點、集結
-- 以版本號做「先到先得」寫入，避免重複購買或重複結算。
-- 已經建立過的專案只要再執行一次本檔即可（皆為 if not exists / or replace）
-- ============================================================
create table if not exists public.jdqs_objects (
  kind       text not null,
  id         text not null,
  lat        double precision,
  lon        double precision,
  data       jsonb not null default '{}'::jsonb,
  ver        integer not null default 1,
  updated_at bigint not null,
  primary key (kind, id)
);
create index if not exists jdqs_objects_pos on public.jdqs_objects (kind, lat, lon);
alter table public.jdqs_objects enable row level security;
revoke all on public.jdqs_objects from anon, authenticated;

-- 範圍內某種類的物件（沒有位置的全域物件一律回傳）
create or replace function public.jdqs_obj_list(p_kind text, p_lat double precision, p_lon double precision, p_km double precision)
returns json language sql security definer set search_path = public as $$
  select json_build_object('status', 'ok', 'objects', coalesce(json_agg(json_build_object(
    'kind', o.kind, 'id', o.id, 'lat', o.lat, 'lon', o.lon, 'data', o.data, 'ver', o.ver, 'updatedAt', o.updated_at)), '[]'::json))
  from (
    select * from public.jdqs_objects
    where kind = p_kind
      and (lat is null or (abs(lat - p_lat) <= least(p_km, 20) / 111.32
        and abs(lon - p_lon) <= least(p_km, 20) / (111.32 * greatest(cos(radians(p_lat)), 0.1))))
    order by updated_at desc
    limit 500
  ) o;
$$;

-- 一次查詢多種物件（每種各自的範圍）
create or replace function public.jdqs_obj_list_many(p_kinds text[], p_kms double precision[], p_lat double precision, p_lon double precision)
returns json language sql security definer set search_path = public as $$
  select json_build_object('status', 'ok', 'objects', coalesce(json_agg(json_build_object(
    'kind', o.kind, 'id', o.id, 'lat', o.lat, 'lon', o.lon, 'data', o.data, 'ver', o.ver, 'updatedAt', o.updated_at)), '[]'::json))
  from (
    select x.* from unnest(p_kinds[1:10], p_kms[1:10]) as q(kind, km)
    cross join lateral (
      select * from public.jdqs_objects o
      where o.kind = q.kind
        and (o.lat is null or (abs(o.lat - p_lat) <= least(q.km, 20) / 111.32
          and abs(o.lon - p_lon) <= least(q.km, 20) / (111.32 * greatest(cos(radians(p_lat)), 0.1))))
      order by o.updated_at desc
      limit 500
    ) x
  ) o;
$$;

-- 以版本號寫入：p_ver 必須等於目前版本（新建時為 0），否則回傳 conflict 與最新資料
create or replace function public.jdqs_obj_put(p_from text, p_token text, p_kind text, p_id text,
  p_lat double precision, p_lon double precision, p_data jsonb, p_ver integer)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
declare cur public.jdqs_objects;
declare now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  select * into s from public.jdqs_world where id = p_from;
  if not found or s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  if p_kind !~ '^[a-z]{2,12}$' or p_id is null or length(p_id) > 80 then return json_build_object('status', 'invalid'); end if;
  if octet_length(coalesce(p_data, 'null'::jsonb)::text) > 16000 then return json_build_object('status', 'invalid'); end if;
  -- 偶爾清除 14 天沒有更新的物件
  if random() < 0.02 then
    delete from public.jdqs_objects where updated_at < now_ms - 14::bigint * 86400000;
  end if;
  select * into cur from public.jdqs_objects where kind = p_kind and id = p_id for update;
  if coalesce(cur.ver, 0) <> coalesce(p_ver, 0) then
    return json_build_object('status', 'conflict', 'obj', case when cur.id is null then null else json_build_object(
      'kind', cur.kind, 'id', cur.id, 'lat', cur.lat, 'lon', cur.lon, 'data', cur.data, 'ver', cur.ver, 'updatedAt', cur.updated_at) end);
  end if;
  if coalesce(p_ver, 0) = 0 then
    -- 新建：同時有人建立時只有一人成功
    insert into public.jdqs_objects (kind, id, lat, lon, data, ver, updated_at)
      values (p_kind, p_id, p_lat, p_lon, coalesce(p_data, '{}'::jsonb), 1, now_ms)
      on conflict (kind, id) do nothing;
  else
    update public.jdqs_objects set lat = p_lat, lon = p_lon, data = coalesce(p_data, '{}'::jsonb), ver = p_ver + 1, updated_at = now_ms
      where kind = p_kind and id = p_id and ver = p_ver;
  end if;
  if not found then
    select * into cur from public.jdqs_objects where kind = p_kind and id = p_id;
    return json_build_object('status', 'conflict', 'obj', case when cur.id is null then null else json_build_object(
      'kind', cur.kind, 'id', cur.id, 'lat', cur.lat, 'lon', cur.lon, 'data', cur.data, 'ver', cur.ver, 'updatedAt', cur.updated_at) end);
  end if;
  return json_build_object('status', 'ok', 'obj', json_build_object(
    'kind', p_kind, 'id', p_id, 'lat', p_lat, 'lon', p_lon, 'data', p_data, 'ver', coalesce(p_ver, 0) + 1, 'updatedAt', now_ms));
end $$;

revoke all on function public.jdqs_obj_list(text, double precision, double precision, double precision) from public;
revoke all on function public.jdqs_obj_put(text, text, text, text, double precision, double precision, jsonb, integer) from public;
grant execute on function public.jdqs_obj_list(text, double precision, double precision, double precision) to anon, authenticated;
revoke all on function public.jdqs_obj_list_many(text[], double precision[], double precision, double precision) from public;
grant execute on function public.jdqs_obj_list_many(text[], double precision[], double precision, double precision) to anon, authenticated;
grant execute on function public.jdqs_obj_put(text, text, text, text, double precision, double precision, jsonb, integer) to anon, authenticated;

-- ============================================================
-- 全服聊天（v9.6.0）：單一頻道、所有玩家可見、只保留最近 200 則
-- 每位玩家每 5 秒最多 1 則、每則最多 120 字；被 3 位玩家檢舉的訊息自動隱藏
-- 已經建立過的專案只要再執行一次本檔即可（皆為 if not exists / or replace）
-- ============================================================
create table if not exists public.jdqs_chat (
  id        bigserial primary key,
  from_id   text not null,
  from_name text not null,
  civ       integer not null default 0,
  text      text not null,
  at        bigint not null,
  reports   integer not null default 0
);
create index if not exists jdqs_chat_from on public.jdqs_chat (from_id, id desc);
alter table public.jdqs_chat enable row level security;
revoke all on public.jdqs_chat from anon, authenticated;

create table if not exists public.jdqs_chat_reports (
  msg_id  bigint not null,
  from_id text not null,
  primary key (msg_id, from_id)
);
alter table public.jdqs_chat_reports enable row level security;
revoke all on public.jdqs_chat_reports from anon, authenticated;

-- 讀取 p_after 之後的訊息（最多 200 則），以及被檢舉隱藏的訊息編號
create or replace function public.jdqs_chat_list(p_after bigint)
returns json language sql security definer set search_path = public as $$
  select json_build_object('status', 'ok',
    'messages', coalesce((select json_agg(json_build_object(
        'id', m.id, 'from', m.from_id, 'name', m.from_name, 'civ', m.civ, 'text', m.text, 'at', m.at) order by m.id)
      from (select * from public.jdqs_chat where id > coalesce(p_after, 0) and reports < 3 order by id desc limit 200) m), '[]'::json),
    'hidden', coalesce((select json_agg(id) from public.jdqs_chat where reports >= 3), '[]'::json));
$$;

create or replace function public.jdqs_chat_send(p_from text, p_token text, p_text text)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
declare last_at bigint;
declare new_id bigint;
declare t text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
declare now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  select * into s from public.jdqs_world where id = p_from;
  if not found or s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  if char_length(t) < 1 or char_length(t) > 120 then return json_build_object('status', 'invalid'); end if;
  -- 同一位玩家同時送出時依序處理，避免繞過冷卻
  perform pg_advisory_xact_lock(hashtext('jdqs_chat:' || p_from));
  select at into last_at from public.jdqs_chat where from_id = p_from order by id desc limit 1;
  if last_at is not null and now_ms - last_at < 5000 then
    return json_build_object('status', 'slow', 'waitMs', 5000 - (now_ms - last_at));
  end if;
  insert into public.jdqs_chat (from_id, from_name, civ, text, at)
    values (p_from, left(coalesce(s.payload->>'name', '倖存者'), 24),
      coalesce(nullif(s.payload->>'civ', '')::numeric, 0)::integer, t, now_ms)
    returning id into new_id;
  -- 只保留最近 200 則
  delete from public.jdqs_chat where id <= new_id - 200;
  delete from public.jdqs_chat_reports where msg_id <= new_id - 200;
  return json_build_object('status', 'ok', 'msg', json_build_object(
    'id', new_id, 'from', p_from, 'name', left(coalesce(s.payload->>'name', '倖存者'), 24),
    'civ', coalesce(nullif(s.payload->>'civ', '')::numeric, 0)::integer, 'text', t, 'at', now_ms));
end $$;

-- 檢舉：同一人對同一則只算一次，不能檢舉自己
create or replace function public.jdqs_chat_report(p_from text, p_token text, p_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare s public.jdqs_world;
begin
  select * into s from public.jdqs_world where id = p_from;
  if not found or s.token_hash <> p_token then return json_build_object('status', 'forbidden'); end if;
  if not exists (select 1 from public.jdqs_chat where id = p_id and from_id <> p_from) then
    return json_build_object('status', 'ok');
  end if;
  insert into public.jdqs_chat_reports (msg_id, from_id) values (p_id, p_from) on conflict do nothing;
  if found then update public.jdqs_chat set reports = reports + 1 where id = p_id; end if;
  return json_build_object('status', 'ok');
end $$;

revoke all on function public.jdqs_chat_list(bigint) from public;
revoke all on function public.jdqs_chat_send(text, text, text) from public;
revoke all on function public.jdqs_chat_report(text, text, bigint) from public;
grant execute on function public.jdqs_chat_list(bigint) to anon, authenticated;
grant execute on function public.jdqs_chat_send(text, text, text) to anon, authenticated;
grant execute on function public.jdqs_chat_report(text, text, bigint) to anon, authenticated;
