"""Generator v0: a seeded, weighted random walk over existing CLI actions.

The step list is a pure function of (run seed, step count). It never reads a
response: values that only exist at run time (conversation IDs, invite codes,
login codes) appear as whole-argument placeholders that the driver resolves
from the same phase's own earlier outputs. Every phase therefore runs the same
list. Standard library only.

Conversation setups are sampled over the typed space of polis-contracts'
ConversationSetup (queue-rs/polis-contracts/src/setup.rs) and applied with
`conversation new --from`, so the CLI's typed parser and validator decide.
Identities are the entry paths the CLI offers today: anonymous (join, or a
first vote or comment), a one-time invite, a returning invite's login code on
a second config directory, the owner and the site admin. Votes are named only
by their typed choice; the CLI owns the wire value.
"""
import hashlib
import json
import random
import uuid

GENERATOR = 'fuzz-generator/0'
FIXTURE_CONVERSATION = '2p027generated'
# The fixture conversation's accepted statements (server/characterization/fixture.sql).
FIXTURE_STATEMENTS = 2
# polis_contracts::votes::VoteChoice, by name. The CLI flag is the name.
CHOICES = ('agree', 'disagree', 'pass')
MISSING_CONVERSATION = 'generatedmissing'
MISSING_INVITE = 'generatedmissinginvite'
MISSING_LOGIN = 'generatedmissinglogin'

# Text classes for statements and topics. Each text carries a step label so
# it is distinct; 'duplicate' reuses an earlier text in the same conversation.
TEXT_CLASSES = {
    'ascii': 'Generated statement {n}',
    'multibyte': 'Généré énoncé {n} — façade',
    'emoji': 'Generated \U0001F331 statement {n} \U0001F389',
    'rtl': 'بيان مولد {n}',
    'combining': 'Generated é statement {n}',
    'cjk': '生成された意見 {n}',
    'line-separator': 'Generated statement {n}',
    'leading-bom': '﻿Generated statement {n}',
    'script-close': 'Generated </script> statement {n}',
}

# Weighted rules of the walk. Reads are the bulk: they are what the switched
# routes answer.
WEIGHTS = {
    'join-anonymous': 3.0,
    'join-invite': 1.5,
    'join-login-code': 0.6,
    'vote': 5.0,
    'comment': 2.0,
    'moderate': 1.5,
    'read': 6.0,
    'owner-list': 0.4,
}

READS = (
    # (command, the actor kinds that may run it)
    ('statement list', ('participant', 'visitor', 'owner')),
    ('statement view', ('participant', 'visitor')),
    ('statement next', ('participant', 'visitor')),
    ('math view', ('visitor', 'owner')),
    ('conversation view', ('owner', 'admin')),
    ('conversation stats', ('owner',)),
    ('vote mine', ('participant',)),
    ('moderate list', ('owner', 'admin')),
    ('participant status', ('owner',)),
)


def normalize_seed(text):
    value = int(text, 16)
    if not 0 <= value < 1 << 64:
        raise ValueError('run seed is 64-bit hex')
    return f'{value:016x}'


def step_seed(run_seed, index):
    """The /begin seed for step `index`: 12 hex, as the control port requires."""
    return hashlib.sha256(f'{run_seed}:{index}'.encode()).hexdigest()[:12]


def step_uuid(run_seed, index):
    """The CLI fixture UUID for step `index` (fixture-ids builds only)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'fuzz/{run_seed}/{index}'))


def conv(ref):
    return '@conv:' + ref


def text(rng, label, used=None):
    if used and rng.random() < 0.08:
        return 'duplicate', rng.choice(sorted(used))
    name = rng.choice(sorted(TEXT_CLASSES))
    return name, TEXT_CLASSES[name].format(n=label)


def wave(rng):
    owner_invites = rng.randint(1, 3)
    return {'owner_invites': owner_invites, 'per_participant': rng.randint(0, 2)}


def sample_setup(rng, ref):
    """One ConversationSetup over the typed space; field names are the serde names."""
    invitations = rng.choices(['none', 'optional-wave', 'required'], [3, 1, 2])[0]
    if invitations == 'required':
        join_invitations = {'mode': 'required', 'first_wave': wave(rng), 'later_waves': []}
    else:
        join_invitations = {'mode': 'optional', 'waves': [wave(rng)] if invitations == 'optional-wave' else []}
    identity = rng.choices(['optional', 'required', 'allowlist'], [4, 1, 1])[0]
    external = {'mode': identity}
    if identity == 'allowlist':
        external['ids'] = [f'generated-xid-{ref}-{j}' for j in range(rng.randint(1, 3))]
    seeds = []
    for j in range(rng.choices([0, 1, 2, 3], [1, 2, 2, 1])[0]):
        seeds.append(text(rng, f'{ref} seed {j}')[1])
    seeds = sorted(set(seeds), key=seeds.index)
    _, topic = text(rng, f'{ref} topic')
    return {
        'topic': topic,
        'description': rng.choice(['', 'Generated description for ' + ref]),
        'context': '',
        'activity': rng.choices(['open', 'closed'], [9, 1])[0],
        'listing': rng.choices(['listed', 'draft'], [4, 1])[0],
        'join': {'invitations': join_invitations, 'external_identity': external},
        'moderation': rng.choice(['after_submission', 'before_visibility']),
        'visibility': rng.choice(['normal', 'hide_social_list']),
        'data_access': rng.choice(['owner', 'public']),
        'profanity_filter': rng.random() < 0.5,
        'short_url': rng.random() < 0.25,
        'seeds': seeds,
    }


def owner_invites(setup):
    if setup is None:
        return 0
    inv = setup['join']['invitations']
    waves = inv['waves'] if inv['mode'] == 'optional' else [inv['first_wave'], *inv['later_waves']]
    return sum(w['owner_invites'] for w in waves)


def generate(run_seed, steps):
    """Return (setups, step list). Deterministic for (run_seed, steps)."""
    run_seed = normalize_seed(run_seed)
    if steps < 1:
        raise ValueError('at least one step')
    rng = random.Random(int(run_seed, 16))
    participants = [f'p{j}' for j in range(1, rng.randint(3, 6) + 1)]
    created = min(rng.randint(2, 3), max(steps - 1, 0))
    conversations = {'c0': {'setup': None, 'statements': FIXTURE_STATEMENTS, 'texts': set(),
                            'invites': 0, 'harvested': False, 'invited': []}}
    setups = {}
    out = []

    def add(kind, actor, args, **extra):
        out.append({'index': len(out), 'kind': kind, 'actor': actor, 'command': extra.pop('command'),
                    'args': args, **extra})

    for k in range(1, created + 1):
        ref = f'c{k}'
        setup = sample_setup(rng, ref)
        setups[ref] = setup
        conversations[ref] = {'setup': setup, 'statements': len(setup['seeds']), 'texts': set(setup['seeds']),
                              'invites': owner_invites(setup), 'harvested': False, 'invited': []}
        add('create', 'owner', ['conversation', 'new', '--from', f'setup-{ref}.json'],
            command='conversation new', creates=ref)

    refs = sorted(conversations)
    while len(out) < steps:
        rules = dict(WEIGHTS)
        if not any(c['invites'] for c in conversations.values()):
            rules.pop('join-invite')
        if not any(c['invited'] for c in conversations.values()):
            rules.pop('join-login-code')
        rule = rng.choices(sorted(rules), [rules[r] for r in sorted(rules)])[0]
        ref = rng.choice(refs)
        c = conversations[ref]
        person = rng.choice(participants)
        if rule == 'join-anonymous':
            add('join', person, ['join', conv(ref)], command='join', entry='anonymous', conversation=ref)
        elif rule == 'join-invite':
            ref = rng.choice([r for r in refs if conversations[r]['invites']])
            c = conversations[ref]
            if not c['harvested']:
                add('read', 'owner', ['invite', 'list', '--conversation', conv(ref), '--status', 'unused'],
                    command='invite list', conversation=ref, harvests=ref)
                c['harvested'] = True
                if len(out) >= steps:
                    break
            add('join', person, ['join', conv(ref), '--invite', '@invite:' + ref], command='join',
                entry='invite', conversation=ref)
            c['invited'].append(person)
        elif rule == 'join-login-code':
            ref = rng.choice([r for r in refs if conversations[r]['invited']])
            holder = rng.choice(conversations[ref]['invited'])
            add('join', holder + '-d2', ['join', conv(ref), '--login-code', f'@login:{holder}:{ref}'],
                command='join', entry='returning-invite', conversation=ref)
        elif rule == 'vote':
            tid = rng.randrange(0, c['statements'] + 1)
            choice = rng.choice(CHOICES)
            add('vote', person, ['vote', conv(ref), '--statement', str(tid), '--' + choice], command='vote',
                conversation=ref, choice=choice)
        elif rule == 'comment':
            label = f'{run_seed[-6:]}-{len(out)}'
            klass, body = text(rng, label, c['texts'])
            c['texts'].add(body)
            if klass != 'duplicate':
                c['statements'] += 1
            add('comment', person, ['comment', conv(ref), body], command='comment', conversation=ref,
                text_class=klass)
        elif rule == 'moderate':
            tid = rng.randrange(0, c['statements'] + 1)
            verb = rng.choice(['accept', 'reject'])
            add('moderate', 'owner', ['moderate', verb, '--conversation', conv(ref), '--tid', str(tid)],
                command='moderate ' + verb, conversation=ref)
        elif rule == 'owner-list':
            add('read', 'owner', ['conversation', 'list', '--sort', rng.choice(['newest', 'oldest']), '--limit', '10'],
                command='conversation list', contract='owner-list')
        else:
            command, kinds = rng.choice(READS)
            kind = rng.choice(kinds)
            actor = {'participant': person, 'visitor': 'visitor', 'owner': 'owner', 'admin': 'admin'}[kind]
            words = command.split()
            if command in ('conversation view', 'conversation stats'):
                args = [*words, conv(ref)]
            elif command == 'statement view':
                args = [*words, str(rng.randrange(0, c['statements'] + 1)), '--conversation', conv(ref)]
            elif command == 'statement list':
                args = [*words, '--conversation', conv(ref)]
                if rng.random() < 0.3:
                    args += ['--limit', str(rng.choice([1, 2, 500])), '--offset', str(rng.choice([0, 1, 3]))]
            elif command == 'moderate list':
                args = [*words, '--conversation', conv(ref), '--status',
                        rng.choice(['all', 'pending', 'accepted', 'rejected'])]
            else:
                args = [*words, '--conversation', conv(ref)]
            add('read', actor, args, command=command, conversation=ref)
    return setups, out[:steps]


def dump(setups, steps):
    return json.dumps({'setups': setups, 'steps': steps}, indent=2, ensure_ascii=False)
