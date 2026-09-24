# Greg on your phone

Talk to Greg from anywhere — hold a button on your phone, ask, and hear him answer
in his own voice — and get your reminders as notifications.

[← Back to the README](../README.md)

---

## What it can and can't do

**From your phone, Greg can** answer questions, give the time and the weather,
search the web, read the news, play and control music, set, list and cancel
reminders and timers, and remember things about you.

**He can't** see your PC's screen, take screenshots, or read your files. That is
enforced on the PC three separate ways, not by asking the model nicely: the phone's
conversation is never offered those tools, its instructions say it has none, and
the PC refuses them if the model tries anyway. Questions about the screen from the
phone are answered in code — "that only works when you're at the PC".

Everything still happens on your PC: his hearing (Whisper), his brain, his voice.
The phone only records and plays back.

---

## Setting it up

You need **Tailscale**, a free private network for your own devices. It is what
lets your phone reach your PC from anywhere without opening anything to the
internet, and it provides the secure (HTTPS) connection phones require before they
will let a page use the microphone.

1. **Install Tailscale** on your PC and your phone, from
   [tailscale.com/download](https://tailscale.com/download), and sign in to the
   same account on both.
2. **In Greg's Settings, on the Phone tab**, tick **Let my phone reach Greg**. If
   you start him from Greg.exe, also tick **Keep him running when his window is
   closed** — otherwise closing his window stops him, and the phone can't reach him.
3. **Run this once on your PC**, in a terminal:

   ```
   tailscale serve --bg 4757
   ```

   If Tailscale asks you to turn on HTTPS for your network, say yes. The Phone tab
   shows this command, with a Copy button, until it's done.
4. **The Phone tab now shows your phone's address**, like
   `https://your-pc.your-tailnet.ts.net/phone/`. Open it on your phone.
5. **Add it to your home screen.** On an iPhone: Share, then Add to Home Screen —
   and open it from there before the next step, because notifications only work in
   the home-screen app, and it keeps its own pairing. On Android, Chrome offers to
   install it.
6. **Pair it.** On the PC, press **Pair a phone** on the Phone tab; type the
   six-digit code into the phone. The code lasts ten minutes and works once.
7. **Tap "Remind me here"** on the phone if you want reminders as notifications.

The PC has to be **on and awake** for the phone to reach Greg. If Windows puts it
to sleep, set it not to while plugged in (Settings → System → Power).

---

## Using it

- **Hold the big button, talk, let go.** He answers out loud on the phone.
- **Type** instead, in the box underneath.
- **Hold the button while he's talking** to stop him and ask something else.
- **Remind me here** turns reminder notifications on or off for this phone.
- **Unpair** removes this phone. So does **Remove** on the PC's Phone tab — which
  works even if the phone is lost.

Each phone has its own conversation, so something asked on the bus doesn't become
context for a question at the desk. Everything said from a phone is still in
Greg's conversation log, marked with the phone's name.

---

## How it's kept private

- **Nothing is opened to the internet.** Only devices signed in to your own
  Tailscale account can reach the phone address at all.
- **The phone talks to its own small server** (port 4757, this PC only), which
  offers exactly: pairing, talking, hearing, speaking, and turning notifications on
  and off. Greg's settings, memory, files, screen and conversation log have no
  route there — they are not refused, they do not exist.
- **Pairing needs someone at the PC**: codes are only made in Settings, last ten
  minutes, work once, and die after five wrong guesses.
- **Each phone gets a long random key**, and only a fingerprint of it is stored
  (`phones.json`, never published). Removing a phone revokes it immediately.
- **Reminder notifications are encrypted on your PC** before they leave it, and
  travel through your phone's own notification service (Apple's or Google's),
  which carries them but cannot read them. Greg signs them with a key that never
  leaves the PC.

---

## If something's wrong

| What you see | What to check |
| --- | --- |
| "Can't reach Greg" | Is the PC on and awake? Is Greg running? Is Tailscale connected on both? |
| The Phone tab never shows an address | Tailscale is signed in on the PC, and you ran `tailscale serve --bg 4757` |
| "Reminders: not here" | On an iPhone, open Greg from the home-screen icon, not Safari |
| The microphone doesn't start | Allow the microphone for Greg in the phone's settings; it only works over the `https://…ts.net` address |
| "This phone was removed" | It was unpaired on the PC. Pair it again with a new code |
