import { createClient } from '@supabase/supabase-js';

export const ADMIN_EMAIL = 'oiko@gmail.com';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);

export interface Asset { name: string; path: string }
export interface Config {
  codes: string[];
  duration: number;
  order: string;
  res: string;
  text: { size: number; x: number; y: number; color: string };
  bg: (Asset & { video: boolean }) | null;
  layers: (Asset & { x: number; y: number; w: number })[];
  box: (Asset & { x: number; y: number; w: number }) | null;
}
export interface ProjectRow { id: string; name: string; owner_email: string | null; user_id: string; updated_at: string }

export const isAdmin = (email?: string | null): boolean => (email ?? '').toLowerCase() === ADMIN_EMAIL;

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export const signOut = () => supabase.auth.signOut();

export async function uploadAsset(userId: string, blob: Blob, name: string): Promise<string> {
  const path = `${userId}/${crypto.randomUUID()}-${name.replace(/[^\w.\-]+/g, '_')}`;
  const { error } = await supabase.storage.from('assets').upload(path, blob, { contentType: blob.type || undefined });
  if (error) throw error;
  return path;
}

export async function downloadAsset(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from('assets').download(path);
  if (error || !data) throw error ?? new Error('archivo no encontrado');
  return data;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const { data, error } = await supabase
    .from('video_projects')
    .select('id,name,owner_email,user_id,updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data as ProjectRow[];
}

export async function loadProject(id: string): Promise<{ name: string; config: Config }> {
  const { data, error } = await supabase.from('video_projects').select('name,config').eq('id', id).single();
  if (error) throw error;
  return data as { name: string; config: Config };
}

export async function saveProject(id: string | null, name: string, config: Config): Promise<string> {
  if (id) {
    const { error } = await supabase
      .from('video_projects')
      .update({ name, config, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from('video_projects').insert({ name, config }).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteProject(id: string): Promise<void> {
  const { config } = await loadProject(id);
  const paths = [config.bg?.path, ...(config.layers ?? []).map((l) => l.path), config.box?.path].filter(
    (p): p is string => !!p,
  );
  const { error } = await supabase.from('video_projects').delete().eq('id', id);
  if (error) throw error;
  if (paths.length) await supabase.storage.from('assets').remove(paths);
}
