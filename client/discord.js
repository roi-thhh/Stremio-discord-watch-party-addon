import { DiscordSDK } from '@discord/embedded-app-sdk';

export async function initDiscordSession() {
  const isDiscordFrame = window.location.search.includes('frame_id=');
  if (!isDiscordFrame) {
    return {
      inDiscord: false,
      roomId: 'local-room',
      user: { id: 'local-' + Math.random().toString(36).slice(2, 7), username: 'LocalUser' }
    };
  }

  const cfgRes = await fetch('/api/config');
  const { clientId } = await cfgRes.json();
  if (!clientId) {
    throw new Error('DISCORD_CLIENT_ID is not configured on the server.');
  }

  const discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds']
  });

  const tokenRes = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const { access_token } = await tokenRes.json();

  const auth = await discordSdk.commands.authenticate({ access_token });

  return {
    inDiscord: true,
    discordSdk,
    roomId: discordSdk.instanceId || 'discord-room',
    user: {
      id: auth.user.id,
      username: auth.user.global_name || auth.user.username
    }
  };
}
