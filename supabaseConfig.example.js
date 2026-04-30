/**
 * Copy this file to supabaseConfig.js and fill in your Supabase project URL and anon key.
 * Get them from: Supabase Dashboard → Settings → API
 * Do not commit supabaseConfig.js (it is in .gitignore).
 */
window.supabaseConfig = {
  SUPABASE_URL: 'https://your-project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key-here',
  CALLLOG_MASTER_KEY: 'PASTE_HERE',
  /** Optional. Invite emails use this URL first. Must be allow-listed in Supabase Auth Redirect URLs. */
  INVITE_REDIRECT_URL: 'calllog://auth/callback',
  /** Optional. Password reset emails use this URL. Must be allow-listed in Supabase Auth Redirect URLs. */
  PASSWORD_RESET_REDIRECT_URL: 'calllog://auth/callback',
};
