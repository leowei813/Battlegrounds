-- v17.4.0：共用物件只下載有變動的部分（減少流量）。
-- 在 Supabase 後台的 SQL Editor 貼上整段執行一次即可（只新增一個查詢函式與索引，不影響資料與舊版遊戲）。

create index if not exists jdqs_objects_kind_updated on public.jdqs_objects (kind, updated_at desc);

-- 一次查詢多種物件，只回傳 p_sinces（每種各自的時間，毫秒）之後更新過的；每種最多 500 筆、最多 20 種
create or replace function public.jdqs_obj_list_since(p_kinds text[], p_kms double precision[], p_sinces bigint[], p_lat double precision, p_lon double precision)
returns json language sql security definer set search_path = public as $$
  select json_build_object('status', 'ok', 'objects', coalesce(json_agg(json_build_object(
    'kind', o.kind, 'id', o.id, 'lat', o.lat, 'lon', o.lon, 'data', o.data, 'ver', o.ver, 'updatedAt', o.updated_at)), '[]'::json))
  from (
    select x.* from unnest(p_kinds[1:20], p_kms[1:20], p_sinces[1:20]) as q(kind, km, since)
    cross join lateral (
      select * from public.jdqs_objects o
      where o.kind = q.kind
        and o.updated_at > coalesce(q.since, 0)
        and (o.lat is null or (abs(o.lat - p_lat) <= least(q.km, 20) / 111.32
          and abs(o.lon - p_lon) <= least(q.km, 20) / (111.32 * greatest(cos(radians(p_lat)), 0.1))))
      order by o.updated_at desc
      limit 500
    ) x
  ) o;
$$;

revoke all on function public.jdqs_obj_list_since(text[], double precision[], bigint[], double precision, double precision) from public;
grant execute on function public.jdqs_obj_list_since(text[], double precision[], bigint[], double precision, double precision) to anon, authenticated;
