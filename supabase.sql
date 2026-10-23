-- Ejecutar una sola vez en Supabase > SQL Editor

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'oiko@gmail.com'
$$;

create table if not exists public.video_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_email text default (auth.jwt() ->> 'email'),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.video_projects enable row level security;

create policy "proyectos_ver" on public.video_projects for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "proyectos_crear" on public.video_projects for insert to authenticated
  with check (user_id = auth.uid());
create policy "proyectos_editar" on public.video_projects for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy "proyectos_borrar" on public.video_projects for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Archivos (fondos e imágenes), privados, en carpetas por usuario
insert into storage.buckets (id, name, public, file_size_limit)
values ('assets', 'assets', false, 52428800)
on conflict (id) do nothing;

create policy "assets_ver" on storage.objects for select to authenticated
  using (bucket_id = 'assets' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "assets_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "assets_editar" on storage.objects for update to authenticated
  using (bucket_id = 'assets' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "assets_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
