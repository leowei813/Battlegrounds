-- v10.9.1：共用物件查詢改為「最近更新的優先」（每種最多 500 筆，超過時先截掉很久沒變動的）。
-- 在 Supabase 後台的 SQL Editor 貼上整段執行一次即可（只取代這兩個查詢函式，不影響資料）。

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

