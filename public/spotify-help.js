// What to tell somebody about Spotify, given where they have got to.
//
// Setting Spotify up needs a Spotify app, a redirect URI, a client id in .env
// and one visit to an authorise link — and none of that is discoverable from
// inside Greg. It is in the docs, which is no use to somebody who has just
// asked him to play a song and been told he cannot.
//
// Three states, kept apart because each needs something different from the
// person reading. Collapsing them would send somebody who already has a client
// id off to create a second Spotify app.
//
//   off          — switched off in config.json. Nothing to do unless they want it.
//   unconfigured — no client id. Needs .env and a RESTART.
//   unauthorised — client id present, never approved. One click, no restart.
//   connected    — done.
//
// The restart matters and is always said out loud. A dialog that implies a
// change has taken effect when it has not is the failure this project spends
// most of its time removing.
//
// DOM-free on purpose: settings.js cannot be imported by Node, and the wording
// somebody follows to set something up should not be the untested part.

/**
 * @param {{enabled?: boolean, configured?: boolean, connected?: boolean, redirectUri?: string}} status
 * @param {string} origin - where Greg is being served from, for the login link
 */
export function spotifyGuidance(status = {}, origin = "") {
  const redirect = status.redirectUri || `${origin || "http://127.0.0.1:4747"}/api/spotify/callback`;
  const loginUrl = `${origin || "http://127.0.0.1:4747"}/api/spotify/login`;

  if (status.enabled === false) {
    return {
      state: "off",
      headline: "Spotify is switched off.",
      steps: [`Set "spotify": { "enabled": true } in config.json and restart to use it.`],
      action: null,
    };
  }

  if (status.connected) {
    return {
      state: "connected",
      headline: "Spotify is connected. Ask him to play something.",
      steps: [
        "Naming a particular song needs Spotify Premium — a free account is refused by Spotify itself, whatever Greg does.",
        "Spotify has to be open. Greg tells an existing player what to do rather than playing audio himself.",
      ],
      action: null,
    };
  }

  if (status.configured) {
    return {
      state: "unauthorised",
      headline: "Almost there — Greg needs your permission once.",
      steps: [
        "Click Connect below and approve it. That is the whole remaining step.",
        "It takes effect immediately; no restart.",
      ],
      action: { label: "Connect Spotify", url: loginUrl },
    };
  }

  return {
    state: "unconfigured",
    headline: "Spotify is not set up yet. It takes about two minutes.",
    steps: [
      "Create an app at developer.spotify.com/dashboard — it is free and instant, with no review.",
      // The literal 127.0.0.1 is not a style choice: Spotify rejects "localhost".
      `Add this exact Redirect URI to it: ${redirect} — it must be the literal 127.0.0.1, because Spotify refuses "localhost".`,
      "Copy the app's Client ID into SPOTIFY_CLIENT_ID in the .env file next to start-greg.bat. There is no secret to copy — Greg uses PKCE and never stores one.",
      "Restart Greg, then come back here and press Connect.",
    ],
    action: null,
    needsRestart: true,
  };
}
