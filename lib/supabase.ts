const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

let clientPromise: Promise<ReturnType<typeof import('@supabase/supabase-js').createClient>> | null = null;

export async function getSupabase() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import('@supabase/supabase-js');
      return createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder');
    })();
  }
  return clientPromise;
}
