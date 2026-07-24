// The login gate, the first optional plug-in on the client. A card over the already-rendered world with
// a username, a password, and a "Play as guest" button. Log in and it POSTs to the server's /login, gets
// back a signed token, and resolves with it; main.ts then opens the game socket carrying that token and
// the server names you from your account. Guest resolves with no token and you get a pool name.
//
// Delete this file and call the net setup with a null token: the game is guest-only and otherwise
// untouched. Nothing in the game loop knows the difference, which is what makes it a plug-in.

type LoginResult = { token: string | null };

// Where identity is remembered between page loads, and the reason there are two boxes. A real login goes
// in localStorage, which survives a refresh AND closing the tab, so you come back tomorrow still logged
// in until the token's own 24h runs out. A guest goes in sessionStorage, which survives a refresh but is
// wiped the instant the tab closes, so a refresh keeps the same avatar and a reopened tab is a fresh
// guest. That split is the whole of "refresh keeps you, reopen starts over".
const TOKEN_KEY = "ppp.token"; // localStorage: the login token
const GUEST_KEY = "ppp.guest"; // sessionStorage: the guest's assigned character + name

// The expiry stamped inside a token, in ms. The token is base64url(name|expirySeconds).signature, so the
// first part decodes to plain text and the number after the last bar is the unix expiry.
function tokenExpiryMs(token: string): number {
  const payload = token.split(".")[0];
  let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "="; // atob wants the padding that base64url drops
  const text = atob(b64);
  const bar = text.lastIndexOf("|");
  return Number(text.slice(bar + 1)) * 1000;
}

// The stored login token if there is one and it has not expired, otherwise null (and a stale one is
// cleared on the way out). Called at boot to decide whether the login overlay is needed at all.
export function restoreLoginToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  if (Date.now() >= tokenExpiryMs(token)) {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return token;
}

// The guest identity saved in this tab, if any. Present after a refresh, gone after the tab was closed.
export function restoreGuest(): { character: string; name: string } | null {
  const raw = sessionStorage.getItem(GUEST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Remember the character and name the server handed this guest, so the next refresh in this tab resumes
// the same avatar. Called from the Welcome handler, because that is when the server's choice is known.
export function saveGuest(character: string, name: string) {
  sessionStorage.setItem(GUEST_KEY, JSON.stringify({ character, name }));
}

// The card is dark to match the netcode HUD, centered over a dimmed backdrop. It swallows pointer events
// so a drag on a field never leaks through to orbit the camera behind it, and it removes itself the
// instant a choice is made so the world is clean the moment play starts.
export function showLoginOverlay(loginUrl: string): Promise<LoginResult> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = [
      "position:fixed", "inset:0", "z-index:20", "display:flex",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.35)",
      "font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    ].join(";");
    // Keep any click or drag on the gate from starting a camera orbit on the window behind it.
    backdrop.addEventListener("pointerdown", (e) => e.stopPropagation());

    const card = document.createElement("div");
    card.style.cssText = [
      "display:flex", "flex-direction:column", "gap:10px", "width:260px",
      "padding:20px", "background:rgba(0,0,0,0.7)", "color:#e8e8e8",
      "border-radius:8px", "box-shadow:0 8px 30px rgba(0,0,0,0.4)",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "PunchPunchPunch";
    title.style.cssText = "font-size:16px;font-weight:600;margin-bottom:2px;text-align:center";

    function makeField(placeholder: string, type: string) {
      const input = document.createElement("input");
      input.type = type;
      input.placeholder = placeholder;
      input.style.cssText =
        "padding:8px 10px;font:inherit;border:1px solid #555;border-radius:5px;background:#1c1c1c;color:#e8e8e8";
      return input;
    }
    const userInput = makeField("username", "text");
    const passInput = makeField("password", "password");

    // Hidden until a login actually fails, then it carries the one vague message the server returns.
    const errorLine = document.createElement("div");
    errorLine.style.cssText = "color:#ff8a8a;font-size:12px;min-height:14px;text-align:center";

    function makeButton(label: string, primary: boolean) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = [
        "padding:8px 10px", "font:inherit", "cursor:pointer", "border-radius:5px",
        "border:1px solid #555",
        primary ? "background:#3aa55a;color:#fff" : "background:#2a2a2a;color:#e8e8e8",
      ].join(";");
      return b;
    }
    const loginBtn = makeButton("Log in", true);
    const guestBtn = makeButton("Play as guest", false);

    card.append(title, userInput, passInput, errorLine, loginBtn, guestBtn);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    userInput.focus();

    function finish(result: LoginResult) {
      backdrop.remove();
      resolve(result);
    }

    // Try the credentials against the server. On success we get a token; on a bad password the server
    // says so with one vague line; if the server is unreachable we say that instead of hanging.
    async function attemptLogin() {
      loginBtn.disabled = true;
      errorLine.textContent = "";
      try {
        const res = await fetch(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: userInput.value, password: passInput.value }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          errorLine.textContent = body.error ?? "login failed";
          loginBtn.disabled = false;
          return;
        }
        const body = await res.json();
        localStorage.setItem(TOKEN_KEY, body.token); // remembered so a refresh skips this overlay for 24h
        finish({ token: body.token });
      } catch {
        errorLine.textContent = "server unreachable";
        loginBtn.disabled = false;
      }
    }

    loginBtn.addEventListener("click", attemptLogin);
    guestBtn.addEventListener("click", () => finish({ token: null }));
    // Enter from either field submits the login, the usual reflex.
    for (const field of [userInput, passInput]) {
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") attemptLogin();
      });
    }
  });
}
