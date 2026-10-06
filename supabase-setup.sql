/* =============================================================================
   PLK Bumi Damai — Setup Supabase (jalankan SEKALI di SQL Editor)
   =============================================================================
   Cara pakai:
     1. Buka https://supabase.com → buat project baru (atau pakai project lama)
     2. Dashboard → SQL Editor → New query
     3. Tempel SELURUH isi file ini → klik Run
        (Aman dijalankan ulang — semua perintah idempotent)
     4. Dashboard → Project Settings → API → salin "Project URL" dan
        "anon public" key → tempel ke konstanta SUPABASE_URL dan
        SUPABASE_ANON_KEY di app.js
     5. Selesai. Buka index.html — data lama di localStorage otomatis
        dimigrasikan ke Supabase saat koneksi pertama.

   Catatan keamanan:
     - Website ini belum memakai login, jadi kebijakan RLS di bawah
       mengizinkan siapa pun yang memiliki anon key membaca/menulis.
       Itu memang desain anon key (dipakai di client), TAPI jangan pernah
       menaruh SERVICE ROLE key di app.js.
     - Kalau langkah storage error di SQL editor, buat bucket manual:
       Dashboard → Storage → New bucket → nama "activity-photos" → Public.
   ========================================================================== */


-- =============================================================================
-- 0) AMANKAN DARI TABEL YANG SUDAH ADA (non-destruktif)
--    Beberapa project Supabase sudah punya tabel bawaan (mis. template
--    User Management membuat "profiles" ber-id uuid). Karena itu tabel kita
--    memakai nama "plk_profiles" supaya tidak pernah bentrok.
--    Untuk "activities": kalau ternyata sudah ada dengan skema berbeda,
--    tabel lama di-rename (DATANYA TIDAK DIHAPUS) supaya bisa dibuat ulang.
-- =============================================================================
do $$
begin
    if exists (
        select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = 'activities'
          and table_type = 'BASE TABLE'
    ) and exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'activities'
          and column_name = 'id'
          and data_type <> 'text'
    ) then
        alter table public.activities rename to activities_legacy;
        raise notice 'Tabel public.activities lama (skema berbeda) di-rename ke public.activities_legacy';
    end if;
end $$;


-- =============================================================================
-- 1) TABEL KEGIATAN
-- =============================================================================
create table if not exists public.activities (
    id          text primary key,
    name        text not null,
    date        date not null,
    category    text not null
                check (category in ('pre-acara', 'hari-h', 'pra-acara', 'pasca-acara')),
    start_time  text,                       -- 'HH:MM'
    end_time    text,                       -- 'HH:MM'
    hours       numeric not null default 0 check (hours >= 0),
    description text default '',
    photos      text[] not null default '{}',  -- URL publik di Storage
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- Supabase query: order by date desc (lihat loadActivities di app.js)
create index if not exists activities_date_idx
    on public.activities (date desc);


-- =============================================================================
-- 2) TABEL PROFIL (singleton — selalu ada tepat satu baris, id = 1)
--    Nama plk_profiles disengaja — lihat blok 0 di atas.
-- =============================================================================
create table if not exists public.plk_profiles (
    id          integer primary key check (id = 1),
    name        text not null default 'Mahasiswa Pengabdian',
    nim         text default '-',
    group_name  text default '-',           -- dipetakan dari field "group" di app.js
    program     text default '-',
    target      integer not null default 272,
    avatar_url  text,
    updated_at  timestamptz not null default now()
);

insert into public.plk_profiles (id)
values (1)
on conflict (id) do nothing;


-- =============================================================================
-- 3) TRIGGER updated_at OTOMATIS
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists set_activities_updated_at on public.activities;
create trigger set_activities_updated_at
    before update on public.activities
    for each row execute function public.set_updated_at();

drop trigger if exists set_plk_profiles_updated_at on public.plk_profiles;
create trigger set_plk_profiles_updated_at
    before update on public.plk_profiles
    for each row execute function public.set_updated_at();


-- =============================================================================
-- 4) ROW LEVEL SECURITY — izinkan anon client (tanpa login) CRUD
-- =============================================================================
alter table public.activities   enable row level security;
alter table public.plk_profiles enable row level security;

drop policy if exists "activities_anon_all" on public.activities;
create policy "activities_anon_all"
    on public.activities
    to anon, authenticated
    using (true)
    with check (true);

drop policy if exists "plk_profiles_anon_all" on public.plk_profiles;
create policy "plk_profiles_anon_all"
    on public.plk_profiles
    to anon, authenticated
    using (true)
    with check (true);


-- =============================================================================
-- 5) STORAGE — bucket foto bukti kegiatan (publik, max 5 MB / foto)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'activity-photos',
    'activity-photos',
    true,
    5242880,                                                        -- 5 MB
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

drop policy if exists "activity_photos_public_read" on storage.objects;
create policy "activity_photos_public_read"
    on storage.objects for select
    to anon, authenticated
    using (bucket_id = 'activity-photos');

drop policy if exists "activity_photos_anon_insert" on storage.objects;
create policy "activity_photos_anon_insert"
    on storage.objects for insert
    to anon, authenticated
    with check (bucket_id = 'activity-photos');

drop policy if exists "activity_photos_anon_delete" on storage.objects;
create policy "activity_photos_anon_delete"
    on storage.objects for delete
    to anon, authenticated
    using (bucket_id = 'activity-photos');


-- =============================================================================
-- 6) VERIFIKASI — harus mengembalikan 3 kotak hasil tanpa error merah
-- =============================================================================
select id, name, date, category, hours
from public.activities
order by date desc
limit 10;

select id, name, nim, group_name, target from public.plk_profiles;

select id, public from storage.buckets where id = 'activity-photos';
