(function () {
  const SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

  let client = null;
  let ready = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();

      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Supabase library load failed"));
      document.head.appendChild(s);
    });
  }

  async function getClient() {
    if (client) return client;

    if (!ready) {
      ready = (async () => {
        const cfg = window.STUDY_NOTES_SUPABASE || {};

        if (!cfg.url || !cfg.key || cfg.key.includes("PASTE_YOUR_")) {
          throw new Error("Supabase publishable key is not configured.");
        }

        await loadScript(SUPABASE_CDN);

        if (!window.supabase || typeof window.supabase.createClient !== "function") {
          throw new Error("Supabase library is unavailable.");
        }

        client = window.supabase.createClient(cfg.url, cfg.key);
        return client;
      })();
    }

    return ready;
  }

  function loginUrl() {
    const next = encodeURIComponent(
      location.pathname + location.search + location.hash
    );
    return "login.html?next=" + next;
  }

  // Use getSession() for the normal browser-session check.
  // getUser() can throw AuthSessionMissingError when nobody is logged in,
  // which should NOT be treated as a configuration error.
  async function currentUser() {
    const sb = await getClient();
    const { data, error } = await sb.auth.getSession();

    if (error) throw error;
    return data?.session?.user || null;
  }

  async function requireAuth() {
    try {
      const user = await currentUser();

      if (!user) {
        if (!location.pathname.toLowerCase().endsWith("login.html")) {
          location.replace(loginUrl());
        }
        return null;
      }

      return user;
    } catch (e) {
      console.error("Study Notes auth error:", e);

      // Only configuration/library failures should show an error.
      const msg = e?.message || String(e);

      if (location.pathname.toLowerCase().endsWith("login.html")) {
        return null;
      }

      alert("Login system error: " + msg);
      return null;
    }
  }

  async function signOut() {
    const sb = await getClient();
    await sb.auth.signOut();
    location.replace("login.html");
  }

  async function getProfile(userId) {
    const sb = await getClient();
    const id = userId || (await currentUser())?.id;

    if (!id) return null;

    const { data, error } = await sb.from("profiles")
      .select("id,display_name,role,created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async function isOwner(userId) {
    const p = await getProfile(userId);
    return p?.role === "owner";
  }

  async function saveProfile(displayName) {
    const sb = await getClient();
    const user = await currentUser();

    if (!user) throw new Error("Not logged in");

    const { error } = await sb.from("profiles")
      .upsert({
        id: user.id,
        display_name:
          displayName ||
          user.email?.split("@")[0] ||
          "Student"
      });

    if (error) throw error;
  }

  async function isDemoActive() {
    const sb = await getClient();
    const { data, error } = await sb.rpc("is_demo_active");

    if (error) throw error;
    return !!data;
  }

  async function recordFirstAttempt(mockId, score) {
    const sb = await getClient();
    const user = await currentUser();

    if (!user) throw new Error("Not logged in");

    const { data, error } = await sb.from("mock_attempts")
      .insert({
        user_id: user.id,
        mock_id: String(mockId),
        score: Number(score)
      })
      .select("id,score,submitted_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return { locked: true, inserted: false };
      }
      throw error;
    }

    return { locked: false, inserted: true, data };
  }

  async function getLeaderboard(mockId) {
    const sb = await getClient();
    const { data, error } = await sb.rpc(
      "get_mock_leaderboard",
      { p_mock_id: String(mockId) }
    );

    if (error) throw error;
    return data || [];
  }

  function installUserBar() {
    if (document.getElementById("snAuthBar")) return;

    const bar = document.createElement("div");
    bar.id = "snAuthBar";

    bar.innerHTML = `
      <div class="sn-auth-user">
        <span class="sn-auth-dot"></span>
        <span id="snAuthEmail">...</span>
      </div>
      <a class="sn-auth-rank" href="RANK.html">🏆 Rank</a>
      <button class="sn-auth-logout" id="snAuthLogout">Logout</button>
    `;

    document.body.appendChild(bar);

    document.getElementById("snAuthLogout").onclick = signOut;

    currentUser()
      .then(user => {
        const el = document.getElementById("snAuthEmail");
        if (el) el.textContent = user?.email || "Student";
      })
      .catch(() => {});
  }

  window.StudyNotesAuth = {
    getClient,
    currentUser,
    requireAuth,
    signOut,
    saveProfile,
    getProfile,
    isOwner,
    isDemoActive,
    recordFirstAttempt,
    getLeaderboard,
    installUserBar
  };

  function boot() {
    const file =
      (location.pathname.split("/").pop() || "").toLowerCase();

    if (file === "login.html") return;

    requireAuth().then(user => {
      if (user) installUserBar();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
