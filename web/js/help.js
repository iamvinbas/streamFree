// Help content: where to find stream URLs and keys on each platform, and
// short troubleshooting notes. Platform menus change over time, so the steps
// name the area to look for rather than exact button positions.

import { t } from './i18n.js';

export const PLATFORMS = {
  youtube: { label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', link: 'https://studio.youtube.com' },
  twitch: { label: 'Twitch', url: 'rtmp://live.twitch.tv/app', link: 'https://dashboard.twitch.tv/settings/stream' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', link: 'https://www.facebook.com/live/producer' },
  linkedin: { label: 'LinkedIn', url: '', link: '' },
  kick: { label: 'Kick', url: '', link: 'https://kick.com' },
  x: { label: 'X', url: '', link: '' },
  custom: { label: 'Custom RTMP', url: '', link: '' },
};

/** Step-by-step guide for one platform, in the current language. */
export function platformGuide(id) {
  const guides = {
    youtube: [
      t('Sign in at studio.youtube.com. If you have no channel yet, YouTube asks you to create one.'),
      t('Click Create → Go live. The first time, YouTube may ask to verify your phone and can take up to 24 hours to enable live streaming.'),
      t('Choose Stream (streaming software). Copy the Stream key.'),
      t('In streamFree, add a YouTube destination, paste the key, save, then press Test.'),
      t('Go live in streamFree. If the stream does not start on its own, press Go live in YouTube Studio.'),
    ],
    twitch: [
      t('Sign in at twitch.tv (accounts are free).'),
      t('Open Creator Dashboard → Settings → Stream.'),
      t('Copy the Primary stream key.'),
      t('In streamFree, add a Twitch destination, paste the key, save, then press Test.'),
    ],
    facebook: [
      t('Open Facebook Live Producer (facebook.com/live/producer).'),
      t('Choose where to post (your profile or a page) and select Streaming software.'),
      t('Copy the Stream key. The server URL is already filled in streamFree.'),
      t('Start streaming from streamFree, then press Go live in Live Producer.'),
    ],
    linkedin: [
      t('LinkedIn Live must be enabled for your profile or page.'),
      t('Create a live event and choose a streaming tool as the source.'),
      t('Copy both the Stream URL and the Stream key into streamFree.'),
    ],
    kick: [
      t('Sign in at kick.com and open Dashboard → Settings → Stream.'),
      t('Copy the Stream URL and the Stream key into streamFree.'),
    ],
    x: [
      t('Open Media Studio → Producer and create a broadcast (it may require an eligible account).'),
      t('Add an RTMP source and copy its URL and key into streamFree.'),
    ],
    custom: [
      t('Any server that accepts RTMP or RTMPS works, for example your own Owncast, MediaMTX or nginx-rtmp.'),
      t('Enter its address (rtmp://server/app) and the stream key or name it expects.'),
    ],
  };
  return guides[id] || guides.custom;
}

/** Topics for the Help tab: [title, paragraphs]. */
export function helpTopics() {
  return [
    [t('Getting started'), [
      t('Allow camera and microphone when asked. Your camera appears in the people row below the preview.'),
      t('Use Add to stage to put people on air. Pick a layout under the preview.'),
      t('Press Record to save a file only, or Go live to stream to your destinations.'),
    ]],
    [t('Inviting guests'), [
      t('Press Invite and choose who can join: this computer, your local network, or anyone on the internet.'),
      t('Send the link (or let them scan the QR code). Guests need only a browser; they wait backstage until you add them to the stage.'),
      t('For guests on the internet, streamFree creates a free temporary address with Cloudflare. It changes every time you restart.'),
    ]],
    [t('Recording'), [
      t('Recordings are MP4 files saved on this computer. They stay playable even if the app or computer stops suddenly.'),
      t('Settings → Recordings shows the folder.'),
    ]],
    [t('Troubleshooting'), [
      t('Guests on strict company or mobile networks often cannot connect directly. streamFree then carries their audio and video through its own link automatically; a TURN server in Settings → Guests gives them a faster direct path.'),
      t('The stream is refused: check the stream key, and that the live event or channel is ready. Use Test in Destinations to check the server address.'),
      t('No camera on macOS: open System Settings → Privacy & Security → Camera and allow streamFree.'),
      t('Echo: use headphones, and turn off "Hear guests" in Settings if you do not need it.'),
    ]],
  ];
}

export function cloudflaredInstall() {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return { os: 'macOS', command: 'brew install cloudflared' };
  if (/Win/i.test(ua)) return { os: 'Windows', command: 'winget install --id Cloudflare.cloudflared' };
  return { os: 'Linux', command: '' };
}
