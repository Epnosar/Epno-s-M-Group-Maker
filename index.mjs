import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField
} from 'discord.js';
import fs from 'fs';

const STATE_FILE = '/data/state.json';

/* ----------------------------- state helpers ----------------------------- */

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { guilds: {} };

  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // New format already
  if (raw.guilds) return raw;

  // Migrate old format: { sessions: { "g:<guildId>": sessionObj } }
  const migrated = { guilds: {} };
  if (raw.sessions) {
    for (const [k, sess] of Object.entries(raw.sessions)) {
      const guildId = k.startsWith('g:') ? k.slice(2) : k;
      const sessionId = sess?.id || `s-${guildId}-${Date.now()}`;

      migrated.guilds[guildId] = {
        currentSessionId: sessionId,
        sessions: {
          [sessionId]: {
            ...sess,
            id: sessionId,
            createdAt: sess.createdAt || Date.now(),
            // normalize
            signups: sess.signups || {},
            lastDraft: sess.lastDraft || null
          }
        }
      };
    }
  }
  return migrated;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function ensureGuildState(state, guildId) {
  state.guilds ||= {};
  state.guilds[guildId] ||= { currentSessionId: null, sessions: {} };
  return state.guilds[guildId];
}

function getCurrentSession(guildState) {
  const sid = guildState.currentSessionId;
  return sid ? guildState.sessions[sid] : null;
}

function getSessionById(guildState, sid) {
  return guildState.sessions?.[sid] || null;
}

function pruneOldSessions(guildState, keep = 12) {
  const entries = Object.entries(guildState.sessions || {});
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const keepIds = new Set(entries.slice(0, keep).map(([id]) => id));
  for (const [id] of entries) {
    if (!keepIds.has(id)) delete guildState.sessions[id];
  }
}

/* ----------------------------- permission helpers ----------------------------- */

function isOfficer(member) {
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

/* ----------------------------- UI helpers ----------------------------- */

function rolesToLabel(roleSet) {
  const arr = [...roleSet].sort();
  return arr.length ? arr.join(', ') : 'None';
}

function buildSignupEmbed(session) {
  const signups = session.signups || {};
  const entries = Object.entries(signups).map(([userId, info]) => ({
    id: userId,
    name: info.displayName || `<@${userId}>`,
    roles: new Set(info.roles || [])
  }));

  const tanks = entries.filter(p => p.roles.has('TANK'));
  const heals = entries.filter(p => p.roles.has('HEAL'));
  const dps = entries.filter(p => p.roles.has('DPS'));

  const possibleGroups = Math.min(
    tanks.length,
    heals.length,
    Math.floor(dps.length / 3),
    Math.floor(entries.length / 5)
  );

  const list = (arr) => arr.length ? arr.map(p => `• ${p.name}`).join('\n') : '_None_';

  const lockLine = session.lockAt
    ? `<t:${Math.floor(session.lockAt / 1000)}:F>`
    : 'Not set';

  return new EmbedBuilder()
    .setTitle(`🗝️ ${session.title || 'Mythic+ Signups'}`)
    .setDescription(session.description ? session.description : 'Click roles below to sign up.')
    .setColor(0x8A2BE2) // purple, because why not
    .addFields(
      { name: `⏳ Lock Time`, value: lockLine, inline: true },
      { name: `👥 Signups`, value: `${entries.length}`, inline: true },
      { name: `✅ Possible Groups`, value: `${possibleGroups}`, inline: true },
      { name: `🛡️ Tanks (${tanks.length})`, value: list(tanks), inline: true },
      { name: `💚 Healers (${heals.length})`, value: list(heals), inline: true },
      { name: `⚔️ DPS (${dps.length})`, value: list(dps), inline: true }
    )
    .setTimestamp(new Date())
    .setFooter({ text: `Mythic+ Organizer` });
}

function buildButtons(sessionId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mplus:${sessionId}:toggle:TANK`)
      .setLabel('🛡️ Tank')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mplus:${sessionId}:toggle:HEAL`)
      .setLabel('💚 Healer')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mplus:${sessionId}:toggle:DPS`)
      .setLabel('⚔️ DPS')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mplus:${sessionId}:leave`)
      .setLabel('🚪 Leave')
      .setStyle(ButtonStyle.Danger)
  );
  return [row];
}

 function buildDraftEmbed(session, draft, title = 'Groups Draft') {
  const lines = [];

  draft.groups.forEach((g, idx) => {
    const dps = [g.dps1, g.dps2, g.dps3].filter(Boolean).map(p => p.name).join(', ') || '—';
    lines.push(
      `**Group ${idx + 1}**\n` +
      `🛡️ ${g.tank?.name ?? '—'}\n` +
      `💚 ${g.heal?.name ?? '—'}\n` +
      `⚔️ ${dps}\n`
    );
  });

  const bench = draft.bench?.length ? draft.bench.map(p => p.name).join(', ') : 'None';

  return new EmbedBuilder()
    .setTitle(`📋 ${title}`)
    .setDescription(lines.join('\n'))
    .setColor(0x00BFFF)
    .addFields({ name: `🪑 Bench (${draft.bench?.length || 0})`, value: bench })
    .setFooter({ text: session.title || 'Mythic+ Night' })
    .setTimestamp(new Date());
}

/* ----------------------------- grouping solver ----------------------------- */

function rollGroups(signups, desiredGroups = null, attempts = 200) {
  const players = Object.entries(signups || {}).map(([id, info]) => ({
    id,
    name: info.displayName || `<@${id}>`,
    roles: new Set(info.roles || [])
  }));

  const tanks = players.filter(p => p.roles.has('TANK')).length;
  const heals = players.filter(p => p.roles.has('HEAL')).length;
  const dps = players.filter(p => p.roles.has('DPS')).length;

  const maxByCounts = Math.min(tanks, heals, Math.floor(dps / 3), Math.floor(players.length / 5));
  const targetGroups = desiredGroups ? Math.min(desiredGroups, maxByCounts) : maxByCounts;

  if (targetGroups <= 0) {
    return {
      groups: [],
      bench: players,
      reason: `Cannot form any full groups (tanks=${tanks}, heals=${heals}, dps=${dps}, players=${players.length}).`
    };
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  let best = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const pool = shuffle(players.slice());
    const used = new Set();

    const groups = Array.from({ length: targetGroups }, () => ({
      tank: null,
      heal: null,
      dps: []
    }));

    function pick(role) {
      const candidates = pool.filter(p => p.roles.has(role) && !used.has(p.id));
      if (!candidates.length) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Tanks + Heals
    for (let g = 0; g < groups.length; g++) {
      const t = pick('TANK');
      if (!t) break;
      used.add(t.id);
      groups[g].tank = t;

      const h = pick('HEAL');
      if (!h) break;
      used.add(h.id);
      groups[g].heal = h;
    }

    if (groups.some(gr => !gr.tank || !gr.heal)) continue;

    const dpsCandidates = pool.filter(p => p.roles.has('DPS'));

    function fillDps(groupIndex, slotIndex) {
      if (groupIndex >= groups.length) return true;
      if (slotIndex >= 3) return fillDps(groupIndex + 1, 0);

      const candidates = dpsCandidates
        .filter(p => !used.has(p.id))
        .sort((a, b) => a.roles.size - b.roles.size);

      const top = candidates.slice(0, Math.min(10, candidates.length));
      shuffle(top);

      for (const p of top) {
        used.add(p.id);
        groups[groupIndex].dps.push(p);

        if (fillDps(groupIndex, slotIndex + 1)) return true;

        used.delete(p.id);
        groups[groupIndex].dps.pop();
      }
      return false;
    }

    if (!fillDps(0, 0)) continue;

    const bench = pool.filter(p => !used.has(p.id));
    const score = used.size;

    if (!best || score > best.score) {
      best = { score, groups, bench };
      if (score === targetGroups * 5) break;
    }
  }

  if (!best) {
    return {
      groups: [],
      bench: players,
      reason: `Tried ${attempts} solves but couldn't find a valid assignment. Role distribution is probably too tight.`
    };
  }

  return { groups: best.groups, bench: best.bench, reason: null };
}

function formatGroups(result) {
  if (!result.groups.length) return result.reason || 'No groups formed.';
  const lines = [];
  result.groups.forEach((g, idx) => {
    lines.push(`**Group ${idx + 1}**`);
    lines.push(`Tank: ${g.tank.name}`);
    lines.push(`Healer: ${g.heal.name}`);
    lines.push(`DPS: ${g.dps.map(p => p.name).join(', ')}`);
    lines.push('');
  });
  if (result.bench.length) {
    lines.push(`**Bench (${result.bench.length})**: ${result.bench.map(p => p.name).join(', ')}`);
  }
  return lines.join('\n');
}

/* ----------------------------- draft + swap helpers ----------------------------- */

function draftFromResult(result) {
  return {
    createdAt: Date.now(),
    groups: result.groups.map(g => ({
      tank: g.tank ? { id: g.tank.id, name: g.tank.name, roles: [...g.tank.roles] } : null,
      heal: g.heal ? { id: g.heal.id, name: g.heal.name, roles: [...g.heal.roles] } : null,
      dps1: g.dps?.[0] ? { id: g.dps[0].id, name: g.dps[0].name, roles: [...g.dps[0].roles] } : null,
      dps2: g.dps?.[1] ? { id: g.dps[1].id, name: g.dps[1].name, roles: [...g.dps[1].roles] } : null,
      dps3: g.dps?.[2] ? { id: g.dps[2].id, name: g.dps[2].name, roles: [...g.dps[2].roles] } : null
    })),
    bench: result.bench.map(p => ({ id: p.id, name: p.name, roles: [...p.roles] }))
  };
}

function formatDraft(draft) {
  if (!draft?.groups?.length) return 'No draft available.';
  const lines = [];
  draft.groups.forEach((g, idx) => {
    lines.push(`**Group ${idx + 1}**`);
    lines.push(`Tank: ${g.tank?.name ?? '—'}`);
    lines.push(`Healer: ${g.heal?.name ?? '—'}`);
    const dps = [g.dps1, g.dps2, g.dps3].filter(Boolean).map(p => p.name);
    lines.push(`DPS: ${dps.length ? dps.join(', ') : '—'}`);
    lines.push('');
  });
  if (draft.bench?.length) {
    lines.push(`**Bench (${draft.bench.length})**: ${draft.bench.map(p => p.name).join(', ')}`);
  }
  return lines.join('\n');
}

function findPlayerInDraft(draft, userId) {
  for (let gi = 0; gi < draft.groups.length; gi++) {
    const g = draft.groups[gi];
    for (const slot of ['tank', 'heal', 'dps1', 'dps2', 'dps3']) {
      if (g[slot]?.id === userId) return { where: 'group', gi, slot };
    }
  }
  for (let bi = 0; bi < (draft.bench?.length || 0); bi++) {
    if (draft.bench[bi]?.id === userId) return { where: 'bench', bi };
  }
  return null;
}

function roleAllowedForSlot(player, slot) {
  if (!player) return true;
  const roles = new Set(player.roles || []);
  if (slot === 'tank') return roles.has('TANK');
  if (slot === 'heal') return roles.has('HEAL');
  if (slot.startsWith('dps')) return roles.has('DPS');
  return true;
}

/* ----------------------------- discord setup ----------------------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

const commands = [
  new SlashCommandBuilder()
    .setName('mplus')
    .setDescription('Mythic+ signup and group roller')
    .addSubcommand(sc =>
      sc.setName('create')
        .setDescription('Create a new weekly signup session (fresh signups)')
        .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Optional description'))
        .addIntegerOption(o => o.setName('lock_in_minutes').setDescription('Lock in X minutes from now'))
    )
    .addSubcommand(sc =>
      sc.setName('preview')
        .setDescription('Preview groups privately (officer-only) and create an editable draft')
        .addIntegerOption(o => o.setName('groups').setDescription('How many groups to try to form'))
        .addIntegerOption(o => o.setName('attempts').setDescription('Solver attempts (default 200)'))
    )
    .addSubcommand(sc =>
      sc.setName('swap')
        .setDescription('Swap two players inside the current draft (officer-only)')
        .addUserOption(o => o.setName('a').setDescription('First player').setRequired(true))
        .addUserOption(o => o.setName('b').setDescription('Second player').setRequired(true))
        .addBooleanOption(o => o.setName('force').setDescription('Allow swap even if roles don’t match slots'))
    )
    .addSubcommand(sc =>
      sc.setName('publish')
        .setDescription('Publish the current draft to the channel (officer-only)')
    )
    .addSubcommand(sc =>
      sc.setName('roll')
        .setDescription('Roll groups and post immediately (officer-only)')
        .addIntegerOption(o => o.setName('groups').setDescription('How many groups to try to form'))
        .addIntegerOption(o => o.setName('attempts').setDescription('Solver attempts (default 200)'))
    )
    .addSubcommand(sc =>
      sc.setName('clear')
        .setDescription('Clear signups for the current session (officer-only)')
    )
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  const state = loadState();
  const guildId = interaction.guildId;
  const guildState = ensureGuildState(state, guildId);

  /* ----------------------------- slash commands ----------------------------- */
  if (interaction.isChatInputCommand() && interaction.commandName === 'mplus') {
    const sub = interaction.options.getSubcommand();

    if (!isOfficer(interaction.member)) {
      await interaction.reply({ content: 'Officer-only.', ephemeral: true });
      return;
    }

    if (sub === 'create') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description') || '';
      const lockMin = interaction.options.getInteger('lock_in_minutes');
      const lockAt = lockMin ? Date.now() + lockMin * 60_000 : null;

      const newSessionId = `s-${guildId}-${Date.now()}`;
      const session = {
        id: newSessionId,
        title,
        description,
        lockAt,
        signups: {},
        messageId: null,
        channelId: null,
        createdAt: Date.now(),
        lastDraft: null
      };

      guildState.sessions[newSessionId] = session;
      guildState.currentSessionId = newSessionId;

      pruneOldSessions(guildState, 12);

      const embed = buildSignupEmbed(session);
      const components = buildButtons(session.id);

      const msg = await interaction.channel.send({ embeds: [embed], components });
      session.messageId = msg.id;
      session.channelId = interaction.channelId;

      saveState(state);
      await interaction.reply({ content: 'New signup session created.', ephemeral: true });
      return;
    }

    if (sub === 'preview') {
      const session = getCurrentSession(guildState);
      if (!session) {
        await interaction.reply({ content: 'No active session. Use /mplus create first.', ephemeral: true });
        return;
      }

      const groupsWanted = interaction.options.getInteger('groups');
      const attempts = interaction.options.getInteger('attempts') || 200;

      const result = rollGroups(session.signups, groupsWanted, attempts);
      const draft = draftFromResult(result);
      session.lastDraft = draft;

      saveState(state);

      await interaction.reply({
       content: `Preview draft (not posted). Use /mplus swap then /mplus publish.`,
       embeds: [buildDraftEmbed(session, draft, 'Preview Draft')],
       ephemeral: true
      });
      return;
    }

    if (sub === 'swap') {
      const session = getCurrentSession(guildState);
      if (!session) {
        await interaction.reply({ content: 'No active session. Use /mplus create first.', ephemeral: true });
        return;
      }
      if (!session.lastDraft) {
        await interaction.reply({ content: 'No draft yet. Run /mplus preview first.', ephemeral: true });
        return;
      }

      const aUser = interaction.options.getUser('a');
      const bUser = interaction.options.getUser('b');
      const force = interaction.options.getBoolean('force') || false;

      const draft = session.lastDraft;

      const aLoc = findPlayerInDraft(draft, aUser.id);
      const bLoc = findPlayerInDraft(draft, bUser.id);

      if (!aLoc || !bLoc) {
        await interaction.reply({ content: 'Both players must be in the current draft (groups or bench).', ephemeral: true });
        return;
      }

      const getRef = (loc) => {
        if (loc.where === 'bench') return { container: draft.bench, key: loc.bi, slotName: 'bench' };
        return { container: draft.groups[loc.gi], key: loc.slot, slotName: loc.slot };
      };

      const aRef = getRef(aLoc);
      const bRef = getRef(bLoc);

      const aPlayer = aRef.container[aRef.key];
      const bPlayer = bRef.container[bRef.key];

      if (!force) {
        const aOk = (bRef.slotName === 'bench') ? true : roleAllowedForSlot(aPlayer, bRef.slotName);
        const bOk = (aRef.slotName === 'bench') ? true : roleAllowedForSlot(bPlayer, aRef.slotName);

        if (!aOk || !bOk) {
          await interaction.reply({
            content:
              `Swap would break role eligibility for the slot(s).\n` +
              `Run again with \`force:true\` if you really mean it.`,
            ephemeral: true
          });
          return;
        }
      }

      aRef.container[aRef.key] = bPlayer;
      bRef.container[bRef.key] = aPlayer;

      session.lastDraft = draft;
      saveState(state);

      await interaction.reply({
        content: `Swapped **${aPlayer.name}** and **${bPlayer.name}**.\n\n${formatDraft(draft)}`,
        ephemeral: true
      });
      return;
    }

    if (sub === 'publish') {
  const session = getCurrentSession(guildState);
  if (!session) {
    await interaction.reply({ content: 'No active session. Use /mplus create first.', ephemeral: true });
    return;
  }
  if (!session.lastDraft) {
    await interaction.reply({ content: 'Nothing to publish yet. Run /mplus preview first.', ephemeral: true });
    return;
  }

  // Acknowledge the command privately (so the officer gets feedback)
  await interaction.reply({ content: 'Published.', ephemeral: true });

  // Post publicly to the channel
  await interaction.channel.send({
    content: `📣 **Groups posted!**`,
    embeds: [buildDraftEmbed(session, session.lastDraft, 'Final Groups')]
  });

  return;
}

    if (sub === 'roll') {
      const session = getCurrentSession(guildState);
      if (!session) {
        await interaction.reply({ content: 'No active session. Use /mplus create first.', ephemeral: true });
        return;
      }

      const groupsWanted = interaction.options.getInteger('groups');
      const attempts = interaction.options.getInteger('attempts') || 200;

      const result = rollGroups(session.signups, groupsWanted, attempts);
      await interaction.reply({ content: formatGroups(result) });
      return;
    }

    if (sub === 'clear') {
      const session = getCurrentSession(guildState);
      if (!session) {
        await interaction.reply({ content: 'No active session to clear.', ephemeral: true });
        return;
      }
      session.signups = {};
      session.lastDraft = null;
      saveState(state);
      await interaction.reply({ content: 'Current session signups cleared.', ephemeral: true });
      return;
    }
  }

  /* ----------------------------- buttons ----------------------------- */
  if (interaction.isButton()) {
  const [prefix, sid, action, payload] = interaction.customId.split(':');
  if (prefix !== 'mplus') return;

  const session = getSessionById(guildState, sid);
  if (!session) {
    await interaction.reply({ content: 'This signup session no longer exists.', ephemeral: true });
    return;
  }

  // ADD THIS BLOCK HERE
  if (session.lockAt && Date.now() >= session.lockAt) {
    await interaction.reply({
      content: '🔒 Signups are locked.',
      ephemeral: true
    });
    return;
  }

    const userId = interaction.user.id;
    const displayName = interaction.member?.displayName || interaction.user.username;

    session.signups ||= {};
    session.signups[userId] ||= { roles: [], displayName };

    if (action === 'toggle') {
      const role = payload; // TANK/HEAL/DPS
      const roles = new Set(session.signups[userId].roles || []);

      if (roles.has(role)) roles.delete(role);
      else roles.add(role);

      session.signups[userId].roles = [...roles];
      session.signups[userId].displayName = displayName;

      saveState(state);

      // Update the signup message (if it exists)
      try {
        const channel = await client.channels.fetch(session.channelId);
        const msg = await channel.messages.fetch(session.messageId);
        await msg.edit({ embeds: [buildSignupEmbed(session)], components: buildButtons(session.id) });
      } catch {
        // If message got deleted, ignore.
      }

      await interaction.reply({
        content: `Updated: **${rolesToLabel(new Set(session.signups[userId].roles))}**`,
        ephemeral: true
      });
      return;
    }

    if (action === 'leave') {
      delete session.signups[userId];
      saveState(state);

      try {
        const channel = await client.channels.fetch(session.channelId);
        const msg = await channel.messages.fetch(session.messageId);
        await msg.edit({ embeds: [buildSignupEmbed(session)], components: buildButtons(session.id) });
      } catch {}

      await interaction.reply({ content: 'Removed you from signups.', ephemeral: true });
      return;
    }
  }
});

await registerCommands();
client.login(process.env.DISCORD_TOKEN);