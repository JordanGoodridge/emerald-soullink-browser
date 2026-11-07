#if WASM

#include "global.h"
#include "gba/m4a_internal.h"

#undef NUM_MUSIC_PLAYERS
#undef MAX_LINES
#define NUM_MUSIC_PLAYERS 4
#define MAX_LINES 0

#ifndef TONEDATA_TYPE_REV
#define TONEDATA_TYPE_REV 0x10
#endif
#ifndef TONEDATA_TYPE_CMP
#define TONEDATA_TYPE_CMP 0x20
#endif
#ifndef SOUND_CHANNEL_SF_SPECIAL
#define SOUND_CHANNEL_SF_SPECIAL 0x20
#endif

extern const MPlayFunc gMPlayJumpTableTemplate[];
extern const u8 gClockTable[];
extern const s8 gDeltaEncodingTable[];
u32 MidiKeyToFreq(struct WaveData *wav, u8 key, u8 fineAdjust);

#define WASM_AUDIO_SAMPLE_RATE 32768
#define WASM_AUDIO_FRAMES_PER_VBLANK 548
#define WASM_AUDIO_BUFFER_CAPACITY_FRAMES 16384

static s16 sWasmAudioBuffer[WASM_AUDIO_BUFFER_CAPACITY_FRAMES * 2];
static u32 sWasmAudioReadPos = 0;
static u32 sWasmAudioWritePos = 0;

static u32 sCgbPhase[4];
static u16 sCgbNoiseLfsr = 0x7FFF;

static inline u32 ReadUnalignedU32(const u8 *ptr)
{
    return (u32)ptr[0]
         | ((u32)ptr[1] << 8)
         | ((u32)ptr[2] << 16)
         | ((u32)ptr[3] << 24);
}

u32 umul3232H32(u32 multiplier, u32 multiplicand)
{
    return (u32)(((u64)multiplier * (u64)multiplicand) >> 32);
}

void SoundMainBTM(void)
{
}

void RealClearChain(void *x)
{
    struct SoundChannel *chan = (struct SoundChannel *)x;
    if (chan == NULL)
        return;

    if (chan->track != NULL)
    {
        struct SoundChannel *next = chan->nextChannelPointer;
        struct SoundChannel *prev = chan->prevChannelPointer;

        if (prev != NULL)
            prev->nextChannelPointer = next;
        else
            chan->track->chan = next;

        if (next != NULL)
            next->prevChannelPointer = prev;

        chan->track = NULL;
    }
}

void MPlayJumpTableCopy(MPlayFunc *mplayJumpTable)
{
    s32 i;
    for (i = 0; i < 36; i++)
        mplayJumpTable[i] = gMPlayJumpTableTemplate[i];
}

void TrackStop(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    if (!(track->flags & MPT_FLG_EXIST))
        return;

    struct SoundChannel *chan = track->chan;
    if (chan != NULL)
    {
        struct SoundInfo *soundInfo = SOUND_INFO_PTR;
        while (chan != NULL)
        {
            if (chan->statusFlags != 0)
            {
                u8 type = chan->type & TONEDATA_TYPE_CGB;
                if (type != 0)
                {
                    if (soundInfo != NULL && soundInfo->CgbOscOff != NULL)
                        soundInfo->CgbOscOff(type);
                }
                chan->statusFlags = 0;
            }
            chan->track = NULL;
            chan = chan->nextChannelPointer;
        }
        track->chan = NULL;
    }
}

void ChnVolSetAsm(struct SoundChannel *chan, struct MusicPlayerTrack *track)
{
    s8 volR = track->volMR;
    s8 volL = track->volML;
    u32 vel = chan->velocity;

    chan->rightVolume = (u8)(((u32)(u8)volR * vel) >> 8);
    chan->leftVolume = (u8)(((u32)(u8)volL * vel) >> 8);
}

void ply_fine(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    struct SoundChannel *chan = track->chan;
    while (chan != NULL)
    {
        if (chan->statusFlags != 0)
            chan->statusFlags |= SOUND_CHANNEL_SF_STOP;
        chan->track = NULL;
        chan = chan->nextChannelPointer;
    }
    track->chan = NULL;
    track->flags = 0;
}

void ply_goto(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    const u8 *cmdPtr = track->cmdPtr;
    track->cmdPtr = (u8 *)(uintptr_t)ReadUnalignedU32(cmdPtr);
}

void ply_patt(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    if (track->patternLevel < 3)
    {
        const u8 *cmdPtr = track->cmdPtr;
        track->patternStack[track->patternLevel++] = (u8 *)(cmdPtr + 4);
        ply_goto(mplayInfo, track);
    }
    else
    {
        ply_fine(mplayInfo, track);
    }
}

void ply_pend(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    if (track->patternLevel != 0)
    {
        track->cmdPtr = track->patternStack[--track->patternLevel];
    }
}

void ply_rept(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    const u8 *cmdPtr = track->cmdPtr;
    u8 count = *cmdPtr;
    if (count == 0)
    {
        track->cmdPtr = (u8 *)(cmdPtr + 1);
        ply_goto(mplayInfo, track);
    }
    else
    {
        u8 repC = ++track->repN;
        if (repC < count)
        {
            track->cmdPtr = (u8 *)(cmdPtr + 1);
            ply_goto(mplayInfo, track);
        }
        else
        {
            track->repN = 0;
            track->cmdPtr = (u8 *)(cmdPtr + 5);
        }
    }
}

void ply_prio(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->priority = *track->cmdPtr++;
}

void ply_tempo(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    u32 tempo = *track->cmdPtr++;
    tempo *= 2;
    mplayInfo->tempoD = (u16)tempo;
    mplayInfo->tempoI = (u16)((tempo * mplayInfo->tempoU) >> 8);
}

void ply_keysh(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->keyShift = *track->cmdPtr++;
    track->flags |= MPT_FLG_PITCHG;
}

void ply_voice(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    u8 voice = *track->cmdPtr++;
    struct ToneData *tone = &mplayInfo->tone[voice];
    track->tone = *tone;
}

void ply_vol(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->vol = *track->cmdPtr++;
    track->flags |= MPT_FLG_VOLCHG;
}

void ply_pan(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->pan = *track->cmdPtr++ - C_V;
    track->flags |= MPT_FLG_VOLCHG;
}

void ply_bend(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->bend = *track->cmdPtr++ - C_V;
    track->flags |= MPT_FLG_PITCHG;
}

void ply_bendr(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->bendRange = *track->cmdPtr++;
    track->flags |= MPT_FLG_PITCHG;
}

void ply_lfodl(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->lfoDelay = *track->cmdPtr++;
}

void ply_modt(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    u8 type = *track->cmdPtr++;
    if (track->modT != type)
    {
        track->modT = type;
        track->flags |= MPT_FLG_VOLCHG | MPT_FLG_PITCHG;
    }
}

void ply_tune(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->tune = *track->cmdPtr++ - C_V;
    track->flags |= MPT_FLG_PITCHG;
}

void ply_port(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    u8 offset = *track->cmdPtr++;
    s8 val = (s8)*track->cmdPtr++;
    *((u8 *)track + offset) = (u8)val;
}

void clear_modM(struct MusicPlayerTrack *track)
{
    track->modM = 0;
    track->lfoSpeedC = 0;
    if (track->modT == 0)
        track->flags |= MPT_FLG_PITCHG;
    else
        track->flags |= MPT_FLG_VOLCHG;
}

void ply_lfos(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->lfoSpeed = *track->cmdPtr++;
    if (track->lfoSpeed == 0)
        clear_modM(track);
}

void ply_mod(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    track->mod = *track->cmdPtr++;
    if (track->mod == 0)
        clear_modM(track);
}

void ply_endtie(struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    u8 key = *track->cmdPtr;
    if (key < 0x80)
    {
        track->key = key;
        track->cmdPtr++;
    }
    else
    {
        key = track->key;
    }

    struct SoundChannel *chan = track->chan;
    while (chan != NULL)
    {
        if ((chan->statusFlags & (SOUND_CHANNEL_SF_START | SOUND_CHANNEL_SF_ENV))
            && !(chan->statusFlags & SOUND_CHANNEL_SF_STOP)
            && chan->midiKey == key)
        {
            chan->statusFlags |= SOUND_CHANNEL_SF_STOP;
            return;
        }
        chan = chan->nextChannelPointer;
    }
}

void ply_note(u32 note_cmd, struct MusicPlayerInfo *mplayInfo, struct MusicPlayerTrack *track)
{
    struct SoundInfo *soundInfo = SOUND_INFO_PTR;
    if (soundInfo == NULL)
        return;

    track->gateTime = gClockTable[note_cmd];

    u8 b = *track->cmdPtr;
    if (b < 0x80)
    {
        track->key = b;
        track->cmdPtr++;
        b = *track->cmdPtr;
        if (b < 0x80)
        {
            track->velocity = b;
            track->cmdPtr++;
            b = *track->cmdPtr;
            if (b < 0x80)
            {
                track->gateTime += b;
                track->cmdPtr++;
            }
        }
    }

    s32 keyShift = 0;
    struct ToneData *tone = &track->tone;
    u8 toneType = tone->type;

    if (toneType & (TONEDATA_TYPE_RHY | TONEDATA_TYPE_SPL))
    {
        u8 key = track->key;
        const struct ToneData *subGroup = (const struct ToneData *)tone->wav;
        if (toneType & TONEDATA_TYPE_SPL)
        {
            const u8 *keySplitTable = *(const u8 *const *)(&tone->attack);
            tone = (struct ToneData *)&subGroup[keySplitTable[key]];
        }
        else
        {
            tone = (struct ToneData *)&subGroup[key];
        }

        toneType = tone->type;
        if (toneType & (TONEDATA_TYPE_RHY | TONEDATA_TYPE_SPL))
            return;
        if (!(tone->pan_sweep & 0x80))
            keyShift = 0;
        else
            keyShift = (s32)track->keyShift + (s32)track->keyShiftX;
    }
    else
    {
        keyShift = (s32)track->keyShift + (s32)track->keyShiftX;
    }

    s32 midiKey = (s32)track->key + keyShift;
    if (midiKey < 0)
        midiKey = 0;
    else if (midiKey > 0x7F)
        midiKey = 0x7F;

    u16 priority = (u16)mplayInfo->priority + (u16)track->priority;
    if (priority > 0xFF)
        priority = 0xFF;

    u8 cgbType = toneType & TONEDATA_TYPE_CGB;
    struct SoundChannel *chan = NULL;

    if (cgbType != 0)
    {
        if (soundInfo->cgbChans == NULL)
            return;

        struct CgbChannel *cgbChan = &soundInfo->cgbChans[cgbType - 1];
        if ((cgbChan->statusFlags & SOUND_CHANNEL_SF_ON)
            && !(cgbChan->statusFlags & SOUND_CHANNEL_SF_STOP))
        {
            if (cgbChan->priority > priority
                || (cgbChan->priority == priority && cgbChan->track < track))
            {
                return;
            }
        }
        chan = (struct SoundChannel *)cgbChan;
    }
    else
    {
        s32 maxChans = soundInfo->maxChans;
        struct SoundChannel *bestChan = NULL;
        u8 bestPrio = (u8)priority;
        struct MusicPlayerTrack *bestTrack = track;
        bool32 foundStopping = FALSE;
        s32 i;

        for (i = 0; i < maxChans; i++)
        {
            struct SoundChannel *cand = &soundInfo->chans[i];
            if (!(cand->statusFlags & SOUND_CHANNEL_SF_ON))
            {
                chan = cand;
                break;
            }
            if ((cand->statusFlags & SOUND_CHANNEL_SF_STOP) && !foundStopping)
            {
                foundStopping = TRUE;
                bestPrio = cand->priority;
                bestTrack = cand->track;
                bestChan = cand;
            }
            else if (((cand->statusFlags & SOUND_CHANNEL_SF_STOP) && foundStopping)
                     || (!(cand->statusFlags & SOUND_CHANNEL_SF_STOP) && !foundStopping))
            {
                if (cand->priority < bestPrio)
                {
                    bestPrio = cand->priority;
                    bestTrack = cand->track;
                    bestChan = cand;
                }
                else if (cand->priority == bestPrio && cand->track >= bestTrack)
                {
                    bestTrack = cand->track;
                    bestChan = cand;
                }
            }
        }

        if (chan == NULL)
            chan = bestChan;
        if (chan == NULL)
            return;
    }

    RealClearChain(chan);

    chan->prevChannelPointer = NULL;
    chan->nextChannelPointer = track->chan;
    if (track->chan != NULL)
        track->chan->prevChannelPointer = chan;
    track->chan = chan;
    chan->track = track;

    track->lfoDelayC = track->lfoDelay;
    if (track->lfoDelay != 0)
        clear_modM(track);

    TrkVolPitSet(mplayInfo, track);

    chan->gateTime = track->gateTime;
    chan->midiKey = track->key;
    chan->velocity = gScaleTable[track->velocity];
    chan->priority = (u8)priority;
    chan->key = (u8)midiKey;
    chan->rhythmPan = 0;
    chan->type = toneType;
    chan->wav = tone->wav;
    chan->attack = tone->attack;
    chan->decay = tone->decay;
    chan->sustain = tone->sustain;
    chan->release = tone->release;
    chan->pseudoEchoVolume = track->pseudoEchoVolume;
    chan->pseudoEchoLength = track->pseudoEchoLength;

    ChnVolSetAsm(chan, track);

    s32 keyM = (s32)chan->key + (s32)track->keyM;
    if (keyM < 0)
        keyM = 0;

    if (cgbType != 0)
    {
        struct CgbChannel *cgbChan = (struct CgbChannel *)chan;
        cgbChan->length = tone->length;
        if ((tone->pan_sweep & 0x80) || (tone->pan_sweep & 0x7F) == 0)
            cgbChan->sweep = 8;
        else
            cgbChan->sweep = tone->pan_sweep;

        u32 freq = soundInfo->MidiKeyToCgbFreq(cgbType, (u8)keyM, track->pitM);
        cgbChan->frequency = freq;
        cgbChan->statusFlags = SOUND_CHANNEL_SF_START;
    }
    else
    {
        chan->dummy4 = track->unk_3C;
        if (tone->pan_sweep & 0x80)
            chan->rhythmPan = tone->pan_sweep;

        u32 freq;
        if (toneType & TONEDATA_TYPE_FIX)
            freq = chan->wav->freq;
        else
            freq = MidiKeyToFreq(chan->wav, (u8)keyM, track->pitM);

        chan->frequency = freq;
        chan->statusFlags = SOUND_CHANNEL_SF_START;
    }
}

void MPlayMain(struct MusicPlayerInfo *mplayInfo)
{
    if (mplayInfo == NULL || mplayInfo->ident != ID_NUMBER)
        return;

    mplayInfo->ident++;

    if (mplayInfo->MPlayMainNext != NULL)
        mplayInfo->MPlayMainNext(mplayInfo->musicPlayerNext);

    if (mplayInfo->status & MUSICPLAYER_STATUS_PAUSE)
    {
        mplayInfo->ident = ID_NUMBER;
        return;
    }

    FadeOutBody(mplayInfo);

    if (mplayInfo->status & MUSICPLAYER_STATUS_PAUSE)
    {
        mplayInfo->ident = ID_NUMBER;
        return;
    }

    mplayInfo->tempoC += mplayInfo->tempoI;
    while (mplayInfo->tempoC >= 150)
    {
        mplayInfo->tempoC -= 150;

        u32 trackCount = mplayInfo->trackCount;
        struct MusicPlayerTrack *track = mplayInfo->tracks;
        u32 trackBit = 1;
        u32 activeTracks = 0;

        while (trackCount > 0)
        {
            if (track->flags & MPT_FLG_EXIST)
            {
                activeTracks |= trackBit;

                struct SoundChannel *chan = track->chan;
                while (chan != NULL)
                {
                    if (chan->statusFlags & SOUND_CHANNEL_SF_ON)
                    {
                        if (chan->gateTime != 0)
                        {
                            chan->gateTime--;
                            if (chan->gateTime == 0)
                                chan->statusFlags |= SOUND_CHANNEL_SF_STOP;
                        }
                        chan = chan->nextChannelPointer;
                    }
                    else
                    {
                        struct SoundChannel *next = chan->nextChannelPointer;
                        RealClearChain(chan);
                        chan = next;
                    }
                }

                if (track->flags & MPT_FLG_START)
                {
                    Clear64byte(track);
                    track->flags = MPT_FLG_EXIST;
                    track->bendRange = 2;
                    track->volX = 64;
                    track->lfoSpeed = 22;
                    track->tone.type = 1;
                }

                while (track->wait == 0)
                {
                    u8 cmd = *track->cmdPtr;
                    if (cmd < 0x80)
                    {
                        cmd = track->runningStatus;
                    }
                    else
                    {
                        track->cmdPtr++;
                        if (cmd >= 0xBD)
                            track->runningStatus = cmd;
                    }

                    if (cmd >= 0xCF)
                    {
                        soundInfo_plynote:
                        if (SOUND_INFO_PTR != NULL && SOUND_INFO_PTR->plynote != NULL)
                            SOUND_INFO_PTR->plynote(cmd - 0xCF, mplayInfo, track);
                        else
                            ply_note(cmd - 0xCF, mplayInfo, track);
                    }
                    else if (cmd >= 0xB1)
                    {
                        u8 cmdIdx = cmd - 0xB1;
                        if (cmdIdx < 30)
                        {
                            mplayInfo->cmd = cmdIdx;
                            switch (cmdIdx)
                            {
                            case 0: ply_fine(mplayInfo, track); break;
                            case 1: ply_goto(mplayInfo, track); break;
                            case 2: ply_patt(mplayInfo, track); break;
                            case 3: ply_pend(mplayInfo, track); break;
                            case 4: ply_rept(mplayInfo, track); break;
                            case 8: ply_memacc(mplayInfo, track); break;
                            case 9: ply_prio(mplayInfo, track); break;
                            case 10: ply_tempo(mplayInfo, track); break;
                            case 11: ply_keysh(mplayInfo, track); break;
                            case 12: ply_voice(mplayInfo, track); break;
                            case 13: ply_vol(mplayInfo, track); break;
                            case 14: ply_pan(mplayInfo, track); break;
                            case 15: ply_bend(mplayInfo, track); break;
                            case 16: ply_bendr(mplayInfo, track); break;
                            case 17: ply_lfos(mplayInfo, track); break;
                            case 18: ply_lfodl(mplayInfo, track); break;
                            case 19: ply_mod(mplayInfo, track); break;
                            case 20: ply_modt(mplayInfo, track); break;
                            case 23: ply_tune(mplayInfo, track); break;
                            case 26: ply_port(mplayInfo, track); break;
                            case 28: ply_xcmd(mplayInfo, track); break;
                            case 29: ply_endtie(mplayInfo, track); break;
                            default: ply_fine(mplayInfo, track); break;
                            }
                            if (track->flags == 0)
                                goto next_track;
                        }
                        else
                        {
                            track->wait = gClockTable[cmd - 0x80];
                        }
                    }
                    else
                    {
                        track->wait = gClockTable[cmd - 0x80];
                    }
                }

                track->wait--;

                if (track->lfoSpeed != 0 && track->mod != 0)
                {
                    if (track->lfoDelayC != 0)
                    {
                        track->lfoDelayC--;
                    }
                    else
                    {
                        track->lfoSpeedC += track->lfoSpeed;
                        s32 lfoVal;
                        u8 phase = track->lfoSpeedC;
                        if ((s8)(phase - 64) < 0)
                            lfoVal = phase;
                        else
                            lfoVal = 128 - (s32)phase;
                        lfoVal = (track->mod * lfoVal) >> 6;
                        if ((s8)lfoVal != track->modM)
                        {
                            track->modM = (s8)lfoVal;
                            if (track->modT == 0)
                                track->flags |= MPT_FLG_PITCHG;
                            else
                                track->flags |= MPT_FLG_VOLCHG;
                        }
                    }
                }
            }
        next_track:
            trackCount--;
            track++;
            trackBit <<= 1;
        }

        mplayInfo->clock++;
        if (activeTracks == 0)
        {
            mplayInfo->status = MUSICPLAYER_STATUS_PAUSE;
            mplayInfo->ident = ID_NUMBER;
            return;
        }
        mplayInfo->status = activeTracks;
    }

    u32 trackCount = mplayInfo->trackCount;
    struct MusicPlayerTrack *track = mplayInfo->tracks;
    while (trackCount > 0)
    {
        if ((track->flags & MPT_FLG_EXIST) && (track->flags & (MPT_FLG_VOLCHG | MPT_FLG_PITCHG)))
        {
            TrkVolPitSet(mplayInfo, track);
            struct SoundChannel *chan = track->chan;
            while (chan != NULL)
            {
                if (!(chan->statusFlags & SOUND_CHANNEL_SF_ON))
                {
                    struct SoundChannel *next = chan->nextChannelPointer;
                    RealClearChain(chan);
                    chan = next;
                    continue;
                }

                u8 cgbType = chan->type & TONEDATA_TYPE_CGB;
                if (track->flags & MPT_FLG_VOLCHG)
                {
                    ChnVolSetAsm(chan, track);
                    if (cgbType != 0)
                        ((struct CgbChannel *)chan)->modify |= CGB_CHANNEL_MO_VOL;
                }
                if (track->flags & MPT_FLG_PITCHG)
                {
                    s32 keyM = (s32)chan->key + (s32)track->keyM;
                    if (keyM < 0)
                        keyM = 0;
                    if (cgbType != 0)
                    {
                        struct CgbChannel *cgbChan = (struct CgbChannel *)chan;
                        cgbChan->frequency = SOUND_INFO_PTR->MidiKeyToCgbFreq(cgbType, (u8)keyM, track->pitM);
                        cgbChan->modify |= CGB_CHANNEL_MO_PIT;
                    }
                    else
                    {
                        u32 freq;
                        if (chan->type & TONEDATA_TYPE_FIX)
                            freq = chan->wav->freq;
                        else
                            freq = MidiKeyToFreq(chan->wav, (u8)keyM, track->pitM);
                        chan->frequency = freq;
                    }
                }
                chan = chan->nextChannelPointer;
            }
            track->flags &= ~(MPT_FLG_VOLCHG | MPT_FLG_PITCHG);
        }
        trackCount--;
        track++;
    }

    mplayInfo->ident = ID_NUMBER;
}

void m4aSoundVSync(void)
{
    struct SoundInfo *soundInfo = SOUND_INFO_PTR;
    if (soundInfo == NULL || soundInfo->ident > ID_NUMBER + 1)
        return;

    if ((s8)(soundInfo->pcmDmaCounter - 1) <= 0)
        soundInfo->pcmDmaCounter = soundInfo->pcmDmaPeriod;
    else
        soundInfo->pcmDmaCounter--;
}

static s8 DecodeCompressedWaveSample(const struct WaveData *wav, u32 sampleIndex)
{
    u32 block = sampleIndex >> 6;
    u32 rem = sampleIndex & 63;
    const u8 *blockPtr = (const u8 *)wav->data + block * 33;
    s32 s = (s8)blockPtr[0];
    u32 k;

    for (k = 1; k <= rem; k++)
    {
        u8 byte = blockPtr[(k + 1) >> 1];
        u8 nibble = (k & 1) ? (byte & 0xF) : (byte >> 4);
        s += gDeltaEncodingTable[nibble];
    }

    if (s < -128)
        s = -128;
    else if (s > 127)
        s = 127;
    return (s8)s;
}

static s8 ReadWaveSample(const struct WaveData *wav, u8 chanType, u32 pos)
{
    if (wav == NULL || wav->size == 0)
        return 0;
    if (pos >= wav->size)
        pos = wav->size - 1;

    u32 actualPos = (chanType & TONEDATA_TYPE_REV) ? (wav->size - 1 - pos) : pos;
    if (wav->type != 0 || (chanType & TONEDATA_TYPE_CMP))
        return DecodeCompressedWaveSample(wav, actualPos);
    return wav->data[actualPos];
}

void SoundMain(void)
{
    struct SoundInfo *soundInfo = SOUND_INFO_PTR;
    if (soundInfo == NULL || soundInfo->ident != ID_NUMBER)
        return;

    soundInfo->ident++;

    if (soundInfo->MPlayMainHead != NULL)
        soundInfo->MPlayMainHead(soundInfo->musicPlayerHead);

    if (soundInfo->CgbSound != NULL)
        soundInfo->CgbSound();

    s32 maxChans = soundInfo->maxChans;
    s32 i;
    for (i = 0; i < maxChans; i++)
    {
        struct SoundChannel *chan = &soundInfo->chans[i];
        u8 statusFlags = chan->statusFlags;
        if (!(statusFlags & SOUND_CHANNEL_SF_ON))
            continue;

        if (statusFlags & SOUND_CHANNEL_SF_START)
        {
            if (statusFlags & SOUND_CHANNEL_SF_STOP)
            {
                chan->statusFlags = 0;
                continue;
            }
            statusFlags = SOUND_CHANNEL_SF_ENV_ATTACK;
            chan->currentPointer = chan->wav->data;
            chan->count = chan->wav->size;
            chan->fw = 0;
            chan->envelopeVolume = 0;
            if (chan->wav->status & 0xC000)
                statusFlags |= SOUND_CHANNEL_SF_LOOP;
            chan->statusFlags = statusFlags;
        }

        if (statusFlags & SOUND_CHANNEL_SF_IEC)
        {
            if (--chan->pseudoEchoLength == 0)
            {
                chan->statusFlags = 0;
                continue;
            }
        }
        else if (statusFlags & SOUND_CHANNEL_SF_STOP)
        {
            if (statusFlags & SOUND_CHANNEL_SF_SPECIAL)
            {
                chan->statusFlags = 0;
                continue;
            }
            chan->envelopeVolume = (u8)((chan->envelopeVolume * chan->release) >> 8);
            if (chan->envelopeVolume <= chan->pseudoEchoVolume)
            {
                if (chan->pseudoEchoVolume == 0)
                {
                    chan->statusFlags = 0;
                    continue;
                }
                chan->statusFlags |= SOUND_CHANNEL_SF_IEC;
                chan->envelopeVolume = chan->pseudoEchoVolume;
            }
        }
        else if ((statusFlags & SOUND_CHANNEL_SF_ENV) == SOUND_CHANNEL_SF_ENV_DECAY)
        {
            chan->envelopeVolume = (u8)((chan->envelopeVolume * chan->decay) >> 8);
            if (chan->envelopeVolume <= chan->sustain)
            {
                if (chan->sustain == 0 && chan->pseudoEchoVolume == 0)
                {
                    chan->statusFlags = 0;
                    continue;
                }
                chan->envelopeVolume = chan->sustain;
                chan->statusFlags = (statusFlags & ~SOUND_CHANNEL_SF_ENV) | SOUND_CHANNEL_SF_ENV_SUSTAIN;
            }
        }
        else if ((statusFlags & SOUND_CHANNEL_SF_ENV) == SOUND_CHANNEL_SF_ENV_ATTACK)
        {
            u32 nextEnv = (u32)chan->envelopeVolume + (u32)chan->attack;
            if (nextEnv >= 0xFF)
            {
                chan->envelopeVolume = 0xFF;
                chan->statusFlags = (statusFlags & ~SOUND_CHANNEL_SF_ENV) | SOUND_CHANNEL_SF_ENV_DECAY;
            }
            else
            {
                chan->envelopeVolume = (u8)nextEnv;
            }
        }

        u32 env = ((u32)chan->envelopeVolume * (u32)(soundInfo->masterVolume + 1)) >> 4;
        chan->envelopeVolumeRight = (u8)((env * chan->rightVolume) >> 8);
        chan->envelopeVolumeLeft = (u8)((env * chan->leftVolume) >> 8);
    }

    soundInfo->ident = ID_NUMBER;
}

static void MixCgbSample(struct SoundInfo *soundInfo, s32 *outLeft, s32 *outRight)
{
    if (soundInfo->cgbChans == NULL)
        return;

    static const s8 sDutyTable[4][8] = {
        { -1, -1, -1, -1, -1, -1, -1,  1 },
        {  1, -1, -1, -1, -1, -1, -1,  1 },
        {  1, -1, -1, -1, -1,  1,  1,  1 },
        { -1,  1,  1,  1,  1,  1,  1, -1 },
    };

    s32 ch;
    for (ch = 0; ch < 4; ch++)
    {
        struct CgbChannel *cgb = &soundInfo->cgbChans[ch];
        if (!(cgb->statusFlags & SOUND_CHANNEL_SF_ON))
            continue;

        u8 vol = cgb->envelopeVolume;
        if (vol == 0)
            continue;

        s32 sample = 0;
        if (ch < 2)
        {
            u32 regPeriod = 2048 - (cgb->frequency & 0x7FF);
            if (regPeriod == 0)
                regPeriod = 1;
            u32 step = (1048576ULL << 16) / (regPeriod * WASM_AUDIO_SAMPLE_RATE);
            sCgbPhase[ch] += step;
            u32 dutyStep = (sCgbPhase[ch] >> 16) & 7;
            u8 dutyIdx = ((u32)(uintptr_t)cgb->wavePointer) & 3;
            sample = sDutyTable[dutyIdx][dutyStep] * (s32)vol * 64;
        }
        else if (ch == 2)
        {
            u32 regPeriod = 2048 - (cgb->frequency & 0x7FF);
            if (regPeriod == 0)
                regPeriod = 1;
            u32 step = (2097152ULL << 16) / (regPeriod * WASM_AUDIO_SAMPLE_RATE);
            sCgbPhase[2] += step;
            u32 waveIdx = (sCgbPhase[2] >> 16) & 31;
            const u8 *wavePtr = (const u8 *)cgb->currentPointer;
            if (wavePtr != NULL)
            {
                u8 byte = wavePtr[waveIdx >> 1];
                u8 nibble = (waveIdx & 1) ? (byte & 0xF) : (byte >> 4);
                s32 centered = (s32)nibble - 8;
                sample = (centered * (s32)vol * 64) >> 2;
            }
        }
        else
        {
            u32 r = cgb->frequency & 7;
            u32 s = (cgb->frequency >> 4) & 0xF;
            u32 div = (r == 0) ? 8 : (r * 16);
            u32 freqHz = 4194304 >> (s + 1);
            freqHz /= div;
            if (freqHz == 0)
                freqHz = 1;
            u32 step = (freqHz << 16) / WASM_AUDIO_SAMPLE_RATE;
            sCgbPhase[3] += step;
            while (sCgbPhase[3] >= 0x10000)
            {
                sCgbPhase[3] -= 0x10000;
                u16 xorBit = (sCgbNoiseLfsr ^ (sCgbNoiseLfsr >> 1)) & 1;
                sCgbNoiseLfsr = (sCgbNoiseLfsr >> 1) | (xorBit << 14);
                if (cgb->frequency & 8)
                    sCgbNoiseLfsr = (sCgbNoiseLfsr & ~(1 << 6)) | (xorBit << 6);
            }
            sample = ((sCgbNoiseLfsr & 1) ? -1 : 1) * (s32)vol * 48;
        }

        u8 pan = cgb->pan;
        u8 mask = cgb->panMask;
        if (pan & (mask << 4))
            *outLeft += sample;
        if (pan & mask)
            *outRight += sample;
    }
}

void WasmAudioRenderFrame(void)
{
    struct SoundInfo *soundInfo = SOUND_INFO_PTR;
    if (soundInfo == NULL || soundInfo->ident != ID_NUMBER)
        return;

    if (sWasmAudioReadPos > 0 && sWasmAudioWritePos > sWasmAudioReadPos)
    {
        u32 remaining = sWasmAudioWritePos - sWasmAudioReadPos;
        memmove(sWasmAudioBuffer, &sWasmAudioBuffer[sWasmAudioReadPos * 2], remaining * 2 * sizeof(s16));
        sWasmAudioWritePos = remaining;
        sWasmAudioReadPos = 0;
    }
    else if (sWasmAudioReadPos >= sWasmAudioWritePos)
    {
        sWasmAudioReadPos = 0;
        sWasmAudioWritePos = 0;
    }

    s32 maxChans = soundInfo->maxChans;
    u32 frame;

    for (frame = 0; frame < WASM_AUDIO_FRAMES_PER_VBLANK; frame++)
    {
        s32 mixLeft = 0;
        s32 mixRight = 0;
        s32 i;

        for (i = 0; i < maxChans; i++)
        {
            struct SoundChannel *chan = &soundInfo->chans[i];
            if (!(chan->statusFlags & SOUND_CHANNEL_SF_ON))
                continue;
            if (chan->wav == NULL || chan->wav->size == 0)
            {
                chan->statusFlags = 0;
                continue;
            }

            u32 pos = (u32)(chan->currentPointer - chan->wav->data);
            if (pos >= chan->wav->size)
            {
                if (chan->statusFlags & SOUND_CHANNEL_SF_LOOP)
                {
                    pos = chan->wav->loopStart;
                    if (pos >= chan->wav->size)
                        pos = 0;
                    chan->currentPointer = chan->wav->data + pos;
                }
                else
                {
                    chan->statusFlags = 0;
                    continue;
                }
            }

            s8 s0 = ReadWaveSample(chan->wav, chan->type, pos);
            u32 nextPos = pos + 1;
            if (nextPos >= chan->wav->size)
                nextPos = (chan->statusFlags & SOUND_CHANNEL_SF_LOOP) ? chan->wav->loopStart : pos;
            s8 s1 = ReadWaveSample(chan->wav, chan->type, nextPos);

            s32 frac = (chan->fw >> 15) & 0xFF;
            s32 sample = (s32)s0 + (((s32)(s1 - s0) * frac) >> 8);

            mixLeft += (sample * (s32)chan->envelopeVolumeLeft) >> 1;
            mixRight += (sample * (s32)chan->envelopeVolumeRight) >> 1;

            u32 freqStep;
            u32 pcmFreq = soundInfo->pcmFreq ? (u32)soundInfo->pcmFreq : 13379U;
            if (chan->type & TONEDATA_TYPE_FIX)
            {
                freqStep = (u32)((0x800000ULL * (u64)pcmFreq) / WASM_AUDIO_SAMPLE_RATE);
            }
            else
            {
                u64 gbaStep = (u64)(u32)soundInfo->divFreq * (u64)chan->frequency;
                freqStep = (u32)((gbaStep * (u64)pcmFreq) / WASM_AUDIO_SAMPLE_RATE);
            }

            chan->fw += freqStep;
            u32 advance = chan->fw >> 23;
            chan->fw &= 0x7FFFFF;

            if (advance > 0)
            {
                pos += advance;
                while (pos >= chan->wav->size)
                {
                    if (chan->statusFlags & SOUND_CHANNEL_SF_LOOP)
                    {
                        u32 loopLen = chan->wav->size - chan->wav->loopStart;
                        if (loopLen == 0)
                        {
                            pos = chan->wav->loopStart;
                            break;
                        }
                        pos = chan->wav->loopStart + ((pos - chan->wav->loopStart) % loopLen);
                    }
                    else
                    {
                        chan->statusFlags = 0;
                        break;
                    }
                }
                chan->currentPointer = chan->wav->data + pos;
                chan->count = (pos < chan->wav->size) ? (chan->wav->size - pos) : 0;
            }
        }

        MixCgbSample(soundInfo, &mixLeft, &mixRight);

        if (mixLeft < -32768)
            mixLeft = -32768;
        else if (mixLeft > 32767)
            mixLeft = 32767;

        if (mixRight < -32768)
            mixRight = -32768;
        else if (mixRight > 32767)
            mixRight = 32767;

        if (sWasmAudioWritePos >= WASM_AUDIO_BUFFER_CAPACITY_FRAMES)
        {
            memmove(
                sWasmAudioBuffer,
                &sWasmAudioBuffer[2],
                (WASM_AUDIO_BUFFER_CAPACITY_FRAMES - 1) * 2 * sizeof(s16)
            );
            sWasmAudioWritePos = WASM_AUDIO_BUFFER_CAPACITY_FRAMES - 1;
        }

        sWasmAudioBuffer[sWasmAudioWritePos * 2] = (s16)mixLeft;
        sWasmAudioBuffer[sWasmAudioWritePos * 2 + 1] = (s16)mixRight;
        sWasmAudioWritePos++;
    }
}

u32 WasmAudioSampleRate(void)
{
    return WASM_AUDIO_SAMPLE_RATE;
}

u32 WasmAudioAvailableFrames(void)
{
    if (sWasmAudioWritePos <= sWasmAudioReadPos)
        return 0;
    return sWasmAudioWritePos - sWasmAudioReadPos;
}

const s16 *WasmAudioBufferPtr(void)
{
    return &sWasmAudioBuffer[sWasmAudioReadPos * 2];
}

void WasmAudioConsumeFrames(u32 frames)
{
    u32 available = WasmAudioAvailableFrames();
    if (frames >= available)
    {
        sWasmAudioReadPos = 0;
        sWasmAudioWritePos = 0;
    }
    else
    {
        sWasmAudioReadPos += frames;
    }
}

#endif
