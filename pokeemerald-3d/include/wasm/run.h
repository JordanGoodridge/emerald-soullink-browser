#ifndef GUARD_WASM_RUN_H
#define GUARD_WASM_RUN_H

#if WASM
enum WasmRunRandomKind
{
    WASM_RUN_RANDOM_WILD = 0,
    WASM_RUN_RANDOM_TRAINER = 1,
    WASM_RUN_RANDOM_GYM = 2,
    WASM_RUN_RANDOM_ELITE = 3,
    WASM_RUN_RANDOM_CHAMPION = 4,
    WASM_RUN_RANDOM_STARTER = 5,
};

u16 WasmRunRandomSpecies(u32 kind, u16 originalSpecies, u32 contextA, u32 contextB);
u32 WasmRunAllowCapture(u32 areaKey, u16 species, u32 pidLo, u32 pidHi);
u32 WasmRunAllowPcBoxing(u32 personality);
u32 WasmRunAllowItemEffect(u16 species, u32 pidLo, u32 pidHi, u16 itemId, u16 hp, u8 level,
    u8 highestLivingPartyLevel, u8 gymCap, u8 isRareCandy);
u32 WasmRunGymLevelCap(void);
u32 WasmRunInfiniteRareCandy(void);
u32 WasmRunInfiniteMoney(void);
u32 WasmRunGetMoney(void);
u32 WasmRunSetMoney(u32 amount);
u32 WasmRunIsChampion(void);
u32 WasmRunDebugSetChampion(u32 isChampion);
void WasmRunOnEncounter(u32 areaKey, u32 sectionId, u16 species, u8 level, u32 pidLo, u32 pidHi, u32 slotKey);
void WasmRunOnCapture(u32 areaKey, u32 sectionId, u16 species, u8 level, u32 pidLo, u32 pidHi);
void WasmRunOnGift(u32 giftKey, u32 sectionId, u16 species, u8 level, u32 pidLo, u32 pidHi);
u32 WasmRunOnFaint(u32 pidLo, u32 pidHi, u32 cause);
void WasmRunAtSafePoint(u32 outcome);
u32 WasmRunShouldRelease(u32 pidLo, u32 pidHi);
void WasmRunOnPartyWipe(u32 partyWiped);
struct Pokemon;

void WasmRunProcessSafePoint(u32 outcome);
u32 WasmRunFlushPendingReleases(void);
void WasmRunAutoLevelCaughtMon(struct Pokemon *mon);
void WasmRunSyncPartyLevels(void);
u32 WasmRunMapSection(void);
u32 WasmRunSpeciesCount(void);
u32 WasmRunSpeciesAt(u32 index);
u32 WasmRunSpeciesBst(u32 species);
u32 WasmRunSpeciesIsLegendary(u32 species);
u32 WasmRunSpeciesPowerTier(u32 species);
u32 WasmBattleHudCount(void);
u32 WasmBattleHudVisible(u32 battler);
u32 WasmBattleHudSide(u32 battler);
s32 WasmBattleHudX(u32 battler);
s32 WasmBattleHudY(u32 battler);
u32 WasmBattleHudSpecies(u32 battler);
u32 WasmBattleHudType1(u32 battler);
u32 WasmBattleHudType2(u32 battler);
u32 WasmRunTrainerKind(u32 trainerId);
u32 WasmRunGymAceLevel(u32 gymIndex);
u32 WasmRunRareCandyItemId(void);
u32 WasmRunRareCandyCount(void);
u32 WasmRunRefillRareCandy(void);
u32 WasmRunHighestLivingPartyLevel(void);
u32 WasmRunGymBadgeCount(void);
u32 WasmRunPartyCount(void);
u32 WasmRunPartySpecies(u32 index);
u32 WasmRunPartyLevel(u32 index);
u32 WasmRunPartyHp(u32 index);
u32 WasmRunPartyMove(u32 index, u32 moveSlot);
u32 WasmRunPartyPidLo(u32 index);
u32 WasmRunPartyPidHi(u32 index);
u32 WasmRunRelearnableMoveCount(u32 index);
u32 WasmRunRelearnableMoveAt(u32 index, u32 candidateIndex);
u32 WasmRunSetPartyMove(u32 index, u32 moveSlot, u32 move);
u32 WasmRunReleasePid(u32 pidLo, u32 pidHi);
u32 WasmRunQuickStart(u32 starterSpecies, u32 rivalStarterIndex);
u32 WasmRunLoadBaseSave(void);
u32 WasmRunReplaceStarter(u32 starterSpecies);
u32 WasmRunQuickStartSave(void);
u32 WasmCanSaveGame(void);
u32 WasmRunDebugFaintPartySlot(u32 index);
u32 WasmRunDebugAddItem(u16 itemId, u16 quantity);
u32 WasmRunDebugAddPartyMon(u32 species, u32 level, u32 personality);
u32 WasmRunDebugSetBadgeCount(u32 count);
u32 WasmRunDebugAddBoxMon(u32 species, u32 level, u32 pidLo, u32 pidHi);
u32 WasmRunDebugBoxHasPid(u32 pidLo, u32 pidHi);
u32 WasmRunDebugAllowCapture(u32 areaKey, u16 species, u32 pidLo, u32 pidHi);
u32 WasmRunDebugUseItemEffect(u32 index, u16 itemId);
u32 WasmRunDebugConsumeAndRefillRareCandy(void);
u32 WasmRunDebugApplyExpGain(u32 index, u32 expGain);
u32 WasmRunDebugTryBlockedBallThrow(u16 species, u32 pidLo, u32 pidHi);
u32 WasmRunDebugAcceptWildCapture(void);
u32 WasmRunPokeballCount(void);
u32 WasmRunIsCaught(u16 species);
u32 WasmRunDebugRandomSpecies(u32 kind, u16 originalSpecies, u32 contextA, u32 contextB);
u32 WasmRunTestCreateWildMon(u16 originalSpecies, u8 level, u32 slotKey);
u32 WasmRunTestCreateTrainerParty(u16 trainerId);
u32 WasmRunEnemyPartyCount(void);
u32 WasmRunEnemyPartySpecies(u32 index);
u32 WasmRunEnemyPartyLevel(u32 index);
#endif

#endif // GUARD_WASM_RUN_H
