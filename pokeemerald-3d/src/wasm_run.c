#include "global.h"
#include "battle.h"
#include "battle_anim.h"
#include "battle_main.h"
#include "data.h"
#include "event_data.h"
#include "field_control_avatar.h"
#include "fieldmap.h"
#include "field_screen_effect.h"
#include "item.h"
#include "load_save.h"
#include "main.h"
#include "malloc.h"
#include "money.h"
#include "new_game.h"
#include "overworld.h"
#include "palette.h"
#include "pokemon.h"
#include "pokemon_storage_system.h"
#include "pokedex.h"
#include "save.h"
#include "script.h"
#include "sprite.h"
#include "wasm/run.h"
#include "constants/opponents.h"
#include "constants/pokedex.h"
#include "constants/trainers.h"
#include "constants/items.h"
#include "constants/flags.h"
#include "constants/map_groups.h"
#include "constants/region_map_sections.h"
#include "constants/vars.h"
#include "constants/item.h"
#include "constants/moves.h"

#if WASM
#ifndef MAX_MONEY
#define MAX_MONEY 999999
#endif
extern const struct Evolution gEvolutionTable[][EVOS_PER_MON];

// WASM-only bridge accessors. Game behavior is changed only when JavaScript
// supplies an active run hook; import defaults preserve vanilla behavior.
extern u16 WasmRunRandomSpecies(u32 kind, u16 originalSpecies, u32 contextA, u32 contextB);

u32 WasmRunMapSection(void)
{
    return gMapHeader.regionMapSectionId;
}

u32 WasmRunSpeciesCount(void)
{
    // Species IDs are internal enum values, not National Dex numbers. The
    // retired Old Unown IDs are retained for save compatibility but resolve to
    // question-mark graphics, so they are not eligible randomizer species.
    return NUM_SPECIES - 1 - (SPECIES_OLD_UNOWN_Z - SPECIES_OLD_UNOWN_B + 1);
}

u32 WasmRunSpeciesAt(u32 index)
{
    const u32 speciesCount = WasmRunSpeciesCount();
    if (index >= speciesCount)
        return SPECIES_NONE;
    // Preserve the real internal IDs while skipping Old Unown B–Z.
    if (index >= SPECIES_OLD_UNOWN_B - 1)
        return index + 1 + (SPECIES_OLD_UNOWN_Z - SPECIES_OLD_UNOWN_B + 1);
    return index + 1;
}

u32 WasmRunSpeciesBst(u32 species)
{
    u32 bst;
    if (species == SPECIES_NONE || species >= NUM_SPECIES)
        return 0;
    bst = (u32)gSpeciesInfo[species].baseHP
        + (u32)gSpeciesInfo[species].baseAttack
        + (u32)gSpeciesInfo[species].baseDefense
        + (u32)gSpeciesInfo[species].baseSpeed
        + (u32)gSpeciesInfo[species].baseSpAttack
        + (u32)gSpeciesInfo[species].baseSpDefense;
    // Universal Pokemon Randomizer ZX bstForPowerLevels() scales Shedinja's
    // 5 non-HP stats + 1 HP by 6/5 so Wonder Guard's 1 HP does not place it in
    // early-route baby BST buckets.
    if (species == SPECIES_SHEDINJA)
        bst = (bst * 6) / 5;
    return bst;
}

u32 WasmRunSpeciesIsLegendary(u32 species)
{
    switch (species)
    {
    case SPECIES_ARTICUNO:
    case SPECIES_ZAPDOS:
    case SPECIES_MOLTRES:
    case SPECIES_MEWTWO:
    case SPECIES_MEW:
    case SPECIES_RAIKOU:
    case SPECIES_ENTEI:
    case SPECIES_SUICUNE:
    case SPECIES_LUGIA:
    case SPECIES_HO_OH:
    case SPECIES_CELEBI:
    case SPECIES_REGIROCK:
    case SPECIES_REGICE:
    case SPECIES_REGISTEEL:
    case SPECIES_LATIAS:
    case SPECIES_LATIOS:
    case SPECIES_KYOGRE:
    case SPECIES_GROUDON:
    case SPECIES_RAYQUAZA:
    case SPECIES_JIRACHI:
    case SPECIES_DEOXYS:
        return TRUE;
    default:
        return FALSE;
    }
}

static bool8 IsBabySpecies(u32 species)
{
    switch (species)
    {
    case SPECIES_PICHU:
    case SPECIES_CLEFFA:
    case SPECIES_IGGLYBUFF:
    case SPECIES_TOGEPI:
    case SPECIES_TYROGUE:
    case SPECIES_SMOOCHUM:
    case SPECIES_ELEKID:
    case SPECIES_MAGBY:
    case SPECIES_AZURILL:
    case SPECIES_WYNAUT:
        return TRUE;
    default:
        return FALSE;
    }
}

u32 WasmRunSpeciesPowerTier(u32 species)
{
    u32 bst;
    u32 s, i;
    bool8 hasEvo = FALSE;
    bool8 hasPreEvo = FALSE;

    if (species == SPECIES_NONE || species >= NUM_SPECIES)
        return 0;
    if (WasmRunSpeciesIsLegendary(species))
        return 3;

    bst = WasmRunSpeciesBst(species);
    for (i = 0; i < EVOS_PER_MON; i++)
    {
        if (gEvolutionTable[species][i].method != 0
            && gEvolutionTable[species][i].targetSpecies != SPECIES_NONE)
        {
            hasEvo = TRUE;
            break;
        }
    }
    for (s = 1; s < NUM_SPECIES && !hasPreEvo; s++)
    {
        if (IsBabySpecies(s))
            continue;
        for (i = 0; i < EVOS_PER_MON; i++)
        {
            if (gEvolutionTable[s][i].method != 0
                && gEvolutionTable[s][i].targetSpecies == species)
            {
                hasPreEvo = TRUE;
                break;
            }
        }
    }

    // Tier 0: Unevolved basic Pokémon (1-of-2, 1-of-3, babies) + weak single-stage (<360 BST)
    if (!hasPreEvo && hasEvo)
        return 0;
    if (!hasPreEvo && !hasEvo && bst < 360)
        return 0;

    // Tier 1: Mid-stage Pokémon (2-of-3 like Lairon/Grovyle/Kadabra), early-route
    // 2-of-2 evolutions (<=410 BST), and mid-strength single-stage (360..440 BST)
    if (hasPreEvo && hasEvo)
        return 1;
    if (hasPreEvo && !hasEvo && bst <= 410)
        return 1;
    if (!hasPreEvo && !hasEvo && bst <= 440)
        return 1;

    // Tier 2: Fully evolved (2-of-2 >410 BST, 3-of-3) + strong single-stage (>440 BST)
    return 2;
}

u32 WasmBattleHudCount(void)
{
    if (!gMain.inBattle || gMain.callback2 != BattleMainCB2 || gPaletteFade.active)
        return 0;
    if (gBattlersCount > MAX_BATTLERS_COUNT)
        return 0;
    return gBattlersCount;
}

u32 WasmBattleHudVisible(u32 battler)
{
    u8 spriteId;
    if (battler >= WasmBattleHudCount())
        return FALSE;
    if (gBattleMons[battler].species == SPECIES_NONE || gBattleMons[battler].hp == 0)
        return FALSE;
    spriteId = gHealthboxSpriteIds[battler];
    if (spriteId >= MAX_SPRITES)
        return FALSE;
    if (!gSprites[spriteId].inUse || gSprites[spriteId].invisible)
        return FALSE;
    return TRUE;
}

u32 WasmBattleHudSide(u32 battler)
{
    if (battler >= MAX_BATTLERS_COUNT)
        return 0;
    return GetBattlerSide(battler);
}

s32 WasmBattleHudX(u32 battler)
{
    u8 spriteId;
    if (!WasmBattleHudVisible(battler))
        return 0;
    spriteId = gHealthboxSpriteIds[battler];
    return gSprites[spriteId].x + gSprites[spriteId].x2;
}

s32 WasmBattleHudY(u32 battler)
{
    u8 spriteId;
    if (!WasmBattleHudVisible(battler))
        return 0;
    spriteId = gHealthboxSpriteIds[battler];
    return gSprites[spriteId].y + gSprites[spriteId].y2;
}

u32 WasmBattleHudSpecies(u32 battler)
{
    if (!WasmBattleHudVisible(battler))
        return SPECIES_NONE;
    return gBattleMons[battler].species;
}

u32 WasmBattleHudType1(u32 battler)
{
    if (!WasmBattleHudVisible(battler))
        return 0;
    return gBattleMons[battler].types[0];
}

u32 WasmBattleHudType2(u32 battler)
{
    if (!WasmBattleHudVisible(battler))
        return 0;
    return gBattleMons[battler].types[1];
}

u32 WasmRunTrainerKind(u32 trainerId)
{
    if (trainerId >= TRAINER_SECRET_BASE)
        return WASM_RUN_RANDOM_TRAINER;

    switch (gTrainers[trainerId].trainerClass)
    {
    case TRAINER_CLASS_LEADER:
        return WASM_RUN_RANDOM_GYM;
    case TRAINER_CLASS_ELITE_FOUR:
        return WASM_RUN_RANDOM_ELITE;
    case TRAINER_CLASS_CHAMPION:
        return WASM_RUN_RANDOM_CHAMPION;
    default:
        return WASM_RUN_RANDOM_TRAINER;
    }
}

static u8 GetTrainerPartyLevel(const struct Trainer *trainer, u8 index)
{
    switch (trainer->partyFlags)
    {
    case 0:
        return trainer->party.NoItemDefaultMoves[index].lvl;
    case F_TRAINER_PARTY_CUSTOM_MOVESET:
        return trainer->party.NoItemCustomMoves[index].lvl;
    case F_TRAINER_PARTY_HELD_ITEM:
        return trainer->party.ItemDefaultMoves[index].lvl;
    case F_TRAINER_PARTY_CUSTOM_MOVESET | F_TRAINER_PARTY_HELD_ITEM:
        return trainer->party.ItemCustomMoves[index].lvl;
    default:
        return 0;
    }
}

static u8 GetTrainerAceLevel(u16 trainerId)
{
    const struct Trainer *trainer = &gTrainers[trainerId];
    u8 aceLevel = 0;
    u8 i;
    for (i = 0; i < trainer->partySize; i++)
    {
        u8 level = GetTrainerPartyLevel(trainer, i);
        if (level > aceLevel)
            aceLevel = level;
    }
    return aceLevel;
}

u32 WasmRunGymAceLevel(u32 gymIndex)
{
    static const u16 sGymLeaderIds[] = {
        TRAINER_ROXANNE_1,
        TRAINER_BRAWLY_1,
        TRAINER_WATTSON_1,
        TRAINER_FLANNERY_1,
        TRAINER_NORMAN_1,
        TRAINER_WINONA_1,
        TRAINER_TATE_AND_LIZA_1,
        TRAINER_JUAN_1,
    };
    if (gymIndex >= ARRAY_COUNT(sGymLeaderIds))
        return 0;
    return GetTrainerAceLevel(sGymLeaderIds[gymIndex]);
}

static struct Pokemon *WasmRunEffectivePartyMon(u32 index)
{
    if (index == 0 && IsWallyTutorialPartyActive())
        return GetWallyTutorialSavedSlot0();
    return &gPlayerParty[index];
}

u32 WasmRunHighestLivingPartyLevel(void)
{
    u8 i;
    u8 highest = 0;
    for (i = 0; i < PARTY_SIZE; i++)
    {
        struct Pokemon *mon = WasmRunEffectivePartyMon(i);
        if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE
            || GetMonData(mon, MON_DATA_IS_EGG)
            || GetMonData(mon, MON_DATA_HP) == 0)
            continue;
        {
            u8 level = GetMonData(mon, MON_DATA_LEVEL);
            if (level > highest)
                highest = level;
        }
    }
    return highest;
}

u32 WasmRunGymBadgeCount(void)
{
    u32 count = 0;
    u8 i;
    for (i = 0; i < NUM_BADGES; i++)
    {
        if (FlagGet(FLAG_BADGE01_GET + i))
            count++;
    }
    return count;
}

u32 WasmRunGymLevelCap(void)
{
    return WasmRunGymAceLevel(WasmRunGymBadgeCount());
}

u32 WasmRunRareCandyItemId(void)
{
    return ITEM_RARE_CANDY;
}

u32 WasmRunRareCandyCount(void)
{
    u32 count = 0;
    u8 slot;
    u8 pocketId = POCKET_ITEMS;
    for (slot = 0; slot < gBagPockets[pocketId - 1].capacity; slot++)
    {
        if (BagGetItemIdByPocketPosition(pocketId, slot) == ITEM_RARE_CANDY)
            count += BagGetQuantityByPocketPosition(pocketId, slot);
    }
    return count;
}

u32 WasmRunRefillRareCandy(void)
{
    if (!WasmRunInfiniteRareCandy())
        return FALSE;
    return AddBagItem(ITEM_RARE_CANDY, 1);
}

static void WasmRunTeachMovesForLevel(struct Pokemon *mon, u16 species, u8 lvl)
{
    s32 i;
    u16 targetMoveLevel = (u16)(lvl << 9);
    for (i = 0; gLevelUpLearnsets[species][i] != LEVEL_UP_END; i++)
    {
        u16 moveLevel = gLevelUpLearnsets[species][i] & LEVEL_UP_MOVE_LV;
        u16 move;
        if (moveLevel > targetMoveLevel)
            break;
        if (moveLevel != targetMoveLevel)
            continue;
        move = gLevelUpLearnsets[species][i] & LEVEL_UP_MOVE_ID;
        if (GiveMoveToMon(mon, move) == MON_HAS_MAX_MOVES)
            DeleteFirstMoveAndGiveMoveToMon(mon, move);
    }
}

static void WasmRunAutoLevelMonToCeiling(struct Pokemon *mon, u32 highestLiving, u32 gymCap, bool8 allowEvolution)
{
    u16 species;
    u8 level;
    u8 targetLevel;
    u8 lvl;
    u32 personality;
    u16 oldMaxHp;
    u16 oldHp;
    u16 newMaxHp;
    u16 newHp;

    if (mon == NULL || !WasmRunInfiniteRareCandy())
        return;
    species = GetMonData(mon, MON_DATA_SPECIES);
    if (species == SPECIES_NONE || GetMonData(mon, MON_DATA_IS_EGG))
        return;
    oldHp = GetMonData(mon, MON_DATA_HP);
    if (oldHp == 0 || highestLiving == 0)
        return;
    level = GetMonData(mon, MON_DATA_LEVEL);
    targetLevel = (u8)highestLiving;
    if (gymCap > 0 && gymCap < targetLevel)
        targetLevel = (u8)gymCap;
    if (targetLevel > MAX_LEVEL)
        targetLevel = MAX_LEVEL;
    if (level >= targetLevel)
        return;
    personality = GetMonData(mon, MON_DATA_PERSONALITY);
    if (!WasmRunAllowItemEffect(species, personality & 0xffff, personality >> 16,
        ITEM_RARE_CANDY, oldHp, level, (u8)highestLiving, (u8)gymCap, TRUE))
        return;

    oldMaxHp = GetMonData(mon, MON_DATA_MAX_HP);
    for (lvl = level + 1; lvl <= targetLevel; lvl++)
    {
        u32 exp = gExperienceTables[gSpeciesInfo[species].growthRate][lvl];
        SetMonData(mon, MON_DATA_EXP, &exp);
        SetMonData(mon, MON_DATA_LEVEL, &lvl);
        WasmRunTeachMovesForLevel(mon, species, lvl);
        if (allowEvolution)
        {
            u16 targetSpecies;
            CalculateMonStats(mon);
            targetSpecies = GetEvolutionTargetSpecies(mon, EVO_MODE_NORMAL, 0);
            if (targetSpecies != SPECIES_NONE)
            {
                u16 nationalDexNum;
                EvolutionRenameMon(mon, species, targetSpecies);
                species = targetSpecies;
                SetMonData(mon, MON_DATA_SPECIES, &species);
                exp = gExperienceTables[gSpeciesInfo[species].growthRate][lvl];
                SetMonData(mon, MON_DATA_EXP, &exp);
                nationalDexNum = SpeciesToNationalPokedexNum(species);
                GetSetPokedexFlag(nationalDexNum, FLAG_SET_SEEN);
                GetSetPokedexFlag(nationalDexNum, FLAG_SET_CAUGHT);
                WasmRunTeachMovesForLevel(mon, species, lvl);
            }
        }
    }
    CalculateMonStats(mon);
    newMaxHp = GetMonData(mon, MON_DATA_MAX_HP);
    newHp = oldHp + (newMaxHp > oldMaxHp ? newMaxHp - oldMaxHp : 0);
    if (newHp > newMaxHp)
        newHp = newMaxHp;
    if (newHp == 0)
        newHp = 1;
    SetMonData(mon, MON_DATA_HP, &newHp);
}

void WasmRunAutoLevelCaughtMon(struct Pokemon *mon)
{
    WasmRunAutoLevelMonToCeiling(mon, WasmRunHighestLivingPartyLevel(), WasmRunGymLevelCap(), FALSE);
}

void WasmRunSyncPartyLevels(void)
{
    u8 i;
    u32 highestLiving;
    u32 gymCap;
    if (!WasmRunInfiniteRareCandy() || IsWallyTutorialPartyActive())
        return;
    highestLiving = WasmRunHighestLivingPartyLevel();
    gymCap = WasmRunGymLevelCap();
    if (highestLiving == 0)
        return;
    for (i = 0; i < PARTY_SIZE; i++)
        WasmRunAutoLevelMonToCeiling(&gPlayerParty[i], highestLiving, gymCap, TRUE);
}

u32 WasmRunPartyCount(void)
{
    if (IsWallyTutorialPartyActive() && GetWallyTutorialSavedPartyCount() > 0)
        return GetWallyTutorialSavedPartyCount();
    return CalculatePlayerPartyCount();
}

u32 WasmRunPartySpecies(u32 index)
{
    if (index >= PARTY_SIZE)
        return SPECIES_NONE;
    return GetMonData(WasmRunEffectivePartyMon(index), MON_DATA_SPECIES);
}

u32 WasmRunPartyLevel(u32 index)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE)
        return 0;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
        return 0;
    return GetMonData(mon, MON_DATA_LEVEL);
}

u32 WasmRunPartyHp(u32 index)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE)
        return 0;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
        return 0;
    return GetMonData(mon, MON_DATA_HP);
}

u32 WasmRunPartyMove(u32 index, u32 moveSlot)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE || moveSlot >= MAX_MON_MOVES)
        return MOVE_NONE;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
        return MOVE_NONE;
    return GetMonData(mon, MON_DATA_MOVE1 + moveSlot);
}

#define WASM_RUN_RELEARNER_MOVE_CAP 32

static u8 GetWasmRunRelearnableMoves(u32 index, u16 *moves)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE)
        return 0;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE
        || GetMonData(mon, MON_DATA_IS_EGG))
        return 0;
    return GetMoveRelearnerMoves(mon, moves);
}

u32 WasmRunRelearnableMoveCount(u32 index)
{
    u16 moves[WASM_RUN_RELEARNER_MOVE_CAP];
    return GetWasmRunRelearnableMoves(index, moves);
}

u32 WasmRunRelearnableMoveAt(u32 index, u32 candidateIndex)
{
    u16 moves[WASM_RUN_RELEARNER_MOVE_CAP];
    u8 count = GetWasmRunRelearnableMoves(index, moves);
    if (candidateIndex >= count)
        return MOVE_NONE;
    return moves[candidateIndex];
}

u32 WasmRunSetPartyMove(u32 index, u32 moveSlot, u32 move)
{
    struct Pokemon *mon;
    u32 slot;

    if (index >= PARTY_SIZE || moveSlot >= MAX_MON_MOVES
        || move == MOVE_NONE || move >= MOVES_COUNT)
        return FALSE;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE
        || GetMonData(mon, MON_DATA_IS_EGG)
        || GetMonData(mon, MON_DATA_MOVE1 + moveSlot) == move)
        return FALSE;
    for (slot = 0; slot < MAX_MON_MOVES; slot++)
    {
        if (slot != moveSlot && GetMonData(mon, MON_DATA_MOVE1 + slot) == move)
            return FALSE;
    }

    // A replacement starts with the move's base PP and must not inherit the
    // forgotten move's PP Ups for this slot.
    RemoveMonPPBonus(mon, moveSlot);
    SetMonMoveSlot(mon, move, moveSlot);
    return TRUE;
}

u32 WasmRunPokeballCount(void)
{
    u32 count = 0;
    u8 slot;
    u8 pocketId = POCKET_POKE_BALLS;
    for (slot = 0; slot < gBagPockets[pocketId - 1].capacity; slot++)
    {
        if (BagGetItemIdByPocketPosition(pocketId, slot) == ITEM_NONE)
            continue;
        count += BagGetQuantityByPocketPosition(pocketId, slot);
    }
    return count;
}

u32 WasmRunIsCaught(u16 species)
{
    u16 nationalDexNum = SpeciesToNationalPokedexNum(species);
    if (nationalDexNum == NATIONAL_DEX_NONE)
        return FALSE;
    return GetSetPokedexFlag(nationalDexNum, FLAG_GET_CAUGHT);
}

u32 WasmRunPartyPidLo(u32 index)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE)
        return 0;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
        return 0;
    return GetMonData(mon, MON_DATA_PERSONALITY) & 0xffff;
}

u32 WasmRunPartyPidHi(u32 index)
{
    struct Pokemon *mon;
    if (index >= PARTY_SIZE)
        return 0;
    mon = WasmRunEffectivePartyMon(index);
    if (GetMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
        return 0;
    return GetMonData(mon, MON_DATA_PERSONALITY) >> 16;
}

u32 WasmRunEnemyPartyCount(void)
{
    return CalculateEnemyPartyCount();
}

u32 WasmRunEnemyPartySpecies(u32 index)
{
    if (index >= PARTY_SIZE)
        return SPECIES_NONE;
    return GetMonData(&gEnemyParty[index], MON_DATA_SPECIES);
}

u32 WasmRunEnemyPartyLevel(u32 index)
{
    if (index >= PARTY_SIZE || GetMonData(&gEnemyParty[index], MON_DATA_SPECIES) == SPECIES_NONE)
        return 0;
    return GetMonData(&gEnemyParty[index], MON_DATA_LEVEL);
}


u32 WasmRunReleasePid(u32 pidLo, u32 pidHi)
{
    u32 pid = pidLo | (pidHi << 16);
    u8 i;

    for (i = 0; i < PARTY_SIZE; i++)
    {
        struct Pokemon *mon = &gPlayerParty[i];
        if (GetMonData(mon, MON_DATA_SPECIES) != SPECIES_NONE
            && GetMonData(mon, MON_DATA_PERSONALITY) == pid)
        {
            ZeroMonData(mon);
            CompactPartySlots();
            CalculatePlayerPartyCount();
            return TRUE;
        }
    }

    if (gPokemonStoragePtr == NULL)
        return FALSE;
    for (i = 0; i < TOTAL_BOXES_COUNT; i++)
    {
        u8 j;
        for (j = 0; j < IN_BOX_COUNT; j++)
        {
            struct BoxPokemon *boxMon = &gPokemonStoragePtr->boxes[i][j];
            if (GetBoxMonData(boxMon, MON_DATA_SPECIES) != SPECIES_NONE
                && GetBoxMonData(boxMon, MON_DATA_PERSONALITY) == pid)
            {
                ZeroBoxMonData(boxMon);
                return TRUE;
            }
        }
    }
    return FALSE;
}

static void WasmRunApplyPostStarterFlags(u32 starterSpecies)
{
    u16 starterIndex = starterSpecies == SPECIES_TREECKO ? 0
        : starterSpecies == SPECIES_TORCHIC ? 1
        : starterSpecies == SPECIES_MUDKIP ? 2
        : (u16)(starterSpecies % 3);

    FlagSet(FLAG_SYS_POKEMON_GET);
    FlagSet(FLAG_RESCUED_BIRCH);
    FlagSet(FLAG_ADVENTURE_STARTED);
    FlagSet(FLAG_SYS_POKEDEX_GET);
    FlagSet(FLAG_RECEIVED_POKEDEX_FROM_BIRCH);
    FlagSet(FLAG_HIDE_ROUTE_101_BIRCH_ZIGZAGOON_BATTLE);
    FlagSet(FLAG_HIDE_ROUTE_101_BIRCH_STARTERS_BAG);
    FlagSet(FLAG_HIDE_ROUTE_101_ZIGZAGOON);
    FlagClear(FLAG_HIDE_LITTLEROOT_TOWN_BIRCHS_LAB_BIRCH);
    FlagSet(FLAG_HIDE_LITTLEROOT_TOWN_BIRCHS_LAB_RIVAL);
    FlagClear(FLAG_HIDE_ROUTE_101_BOY);
    FlagSet(FLAG_HIDE_ROUTE_103_RIVAL);
    FlagSet(FLAG_DEFEATED_RIVAL_ROUTE103);
    FlagSet(FLAG_SYS_B_DASH);
    FlagSet(FLAG_RECEIVED_RUNNING_SHOES);

    if (WasmRunInfiniteMoney())
        WasmRunSetMoney(MAX_MONEY);

    VarSet(VAR_STARTER_MON, starterIndex);
    VarSet(VAR_LITTLEROOT_INTRO_STATE, 7);
    VarSet(VAR_LITTLEROOT_TOWN_STATE, 4);
    VarSet(VAR_BIRCH_LAB_STATE, 5);
    VarSet(VAR_ROUTE101_STATE, 3);
    VarSet(VAR_LITTLEROOT_RIVAL_STATE, 4);
    VarSet(VAR_OLDALE_TOWN_STATE, 1);
    VarSet(VAR_CABLE_CLUB_TUTORIAL_STATE, 1);
}

u32 WasmRunQuickStart(u32 starterSpecies, u32 rivalStarterIndex)
{
    struct Pokemon starter;
    u8 rivalIndex = rivalStarterIndex % 3;
    u16 nationalDexNum;

    if (starterSpecies == SPECIES_NONE || starterSpecies >= NUM_SPECIES)
        return FALSE;

    WasmRunApplyPostStarterFlags(starterSpecies);
    VarSet(VAR_STARTER_MON, rivalIndex);

    CreateMon(&starter, starterSpecies, 5, USE_RANDOM_IVS, FALSE, 0, OT_ID_PLAYER_ID, 0);
    GiveMonToPlayer(&starter);
    {
        u32 personality = GetMonData(&starter, MON_DATA_PERSONALITY);
        WasmRunOnGift(0x53545254, WasmRunMapSection(), starterSpecies, 5, personality & 0xffff, personality >> 16);
    }
    nationalDexNum = SpeciesToNationalPokedexNum(starterSpecies);
    GetSetPokedexFlag(nationalDexNum, FLAG_SET_SEEN);
    GetSetPokedexFlag(nationalDexNum, FLAG_SET_CAUGHT);
    SetWarpDestination(MAP_GROUP(MAP_ROUTE101), MAP_NUM(MAP_ROUTE101), WARP_ID_NONE, 7, 10);
    DoWarp();
    ResetInitialPlayerAvatarState();
    return TRUE;
}

u32 WasmRunLoadBaseSave(void)
{
    gMain.inBattle = FALSE;
    ResetMenuAndMonGlobals();
    Save_ResetSaveCounters();
    if (LoadGameSave(SAVE_NORMAL) != SAVE_STATUS_OK)
        return FALSE;
    InitHeap(gHeap, HEAP_SIZE);
    SetMainCallback2(CB2_ContinueSavedGame);
    return TRUE;
}

u32 WasmRunReplaceStarter(u32 starterSpecies)
{
    struct Pokemon starter;
    u8 level;
    u16 oldSpecies;
    u16 oldNationalDexNum;
    u16 nationalDexNum;

    if (starterSpecies == SPECIES_NONE || starterSpecies >= NUM_SPECIES
        || CalculatePlayerPartyCount() == 0)
        return FALSE;

    oldSpecies = GetMonData(&gPlayerParty[0], MON_DATA_SPECIES);
    level = GetMonData(&gPlayerParty[0], MON_DATA_LEVEL);
    if (level == 0)
        return FALSE;

    WasmRunApplyPostStarterFlags(starterSpecies);

    oldNationalDexNum = SpeciesToNationalPokedexNum(oldSpecies);
    if (oldNationalDexNum >= 1 && oldNationalDexNum <= NATIONAL_DEX_COUNT)
    {
        u16 index = oldNationalDexNum - 1;
        gSaveBlock2Ptr->pokedex.owned[index / 8] &= ~(1 << (index % 8));
        gSaveBlock2Ptr->pokedex.seen[index / 8] &= ~(1 << (index % 8));
        gSaveBlock1Ptr->seen1[index / 8] &= ~(1 << (index % 8));
        gSaveBlock1Ptr->seen2[index / 8] &= ~(1 << (index % 8));
    }

    CreateMon(&starter, starterSpecies, level, USE_RANDOM_IVS, FALSE, 0, OT_ID_PLAYER_ID, 0);
    gPlayerParty[0] = starter;
    CalculatePlayerPartyCount();
    nationalDexNum = SpeciesToNationalPokedexNum(starterSpecies);
    GetSetPokedexFlag(nationalDexNum, FLAG_SET_SEEN);
    GetSetPokedexFlag(nationalDexNum, FLAG_SET_CAUGHT);
    {
        u32 personality = GetMonData(&gPlayerParty[0], MON_DATA_PERSONALITY);
        WasmRunOnGift(0x53545254, WasmRunMapSection(), starterSpecies, level,
            personality & 0xffff, personality >> 16);
    }
    return TRUE;
}

u32 WasmRunQuickStartSave(void)
{
    return TrySavingData(0) == 1;
}

u32 WasmCanSaveGame(void)
{
    if (gMain.inBattle || IsWallyTutorialPartyActive())
        return FALSE;
    return TRUE;
}

u32 WasmRunGiveStarterPokeballs(void)
{
    // SoulLink quick-start operates on its separate run save, after loading
    // the base save. Grant the capture kit only to that new run checkpoint.
    return AddBagItem(ITEM_POKE_BALL, 5);
}

u32 WasmRunGetMoney(void)
{
    if (gSaveBlock1Ptr == NULL)
        return 0;
    return GetMoney(&gSaveBlock1Ptr->money);
}

u32 WasmRunSetMoney(u32 amount)
{
    u32 clamped = amount > MAX_MONEY ? MAX_MONEY : amount;
    if (gSaveBlock1Ptr == NULL)
        return 0;
    SetMoney(&gSaveBlock1Ptr->money, clamped);
    return GetMoney(&gSaveBlock1Ptr->money);
}

u32 WasmRunIsChampion(void)
{
    return FlagGet(FLAG_IS_CHAMPION) || FlagGet(FLAG_SYS_GAME_CLEAR);
}

void WasmRunProcessSafePoint(u32 outcome)
{
    u8 i;
    u8 livingCount = 0;
    WasmRunAtSafePoint(outcome);
    if (IsWallyTutorialPartyActive())
        return;
    if (WasmRunInfiniteMoney())
        WasmRunSetMoney(MAX_MONEY);

    // First report every locally fainted member so JS can propagate deaths to
    // linked partners. Then apply local/remote pending releases at this safe
    // point only, never while the battle controller still owns the party.
    for (i = 0; i < PARTY_SIZE;)
    {
        struct Pokemon *mon = &gPlayerParty[i];
        u16 species = GetMonData(mon, MON_DATA_SPECIES);
        u32 personality;
        u32 pidLo, pidHi;
        if (species == SPECIES_NONE)
        {
            i++;
            continue;
        }
        personality = GetMonData(mon, MON_DATA_PERSONALITY);
        pidLo = personality & 0xffff;
        pidHi = personality >> 16;
        if (GetMonData(mon, MON_DATA_HP) == 0)
            WasmRunOnFaint(pidLo, pidHi, 0);
        if (WasmRunShouldRelease(pidLo, pidHi))
        {
            WasmRunReleasePid(pidLo, pidHi);
            // Party compaction moves the next Pokémon into this slot.
            continue;
        }
        i++;
    }

    if (gPokemonStoragePtr != NULL)
    {
        u8 box;
        for (box = 0; box < TOTAL_BOXES_COUNT; box++)
        {
            u8 position;
            for (position = 0; position < IN_BOX_COUNT; position++)
            {
                struct BoxPokemon *mon = &gPokemonStoragePtr->boxes[box][position];
                u32 personality;
                u32 pidLo, pidHi;
                if (GetBoxMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
                    continue;
                personality = GetBoxMonData(mon, MON_DATA_PERSONALITY);
                pidLo = personality & 0xffff;
                pidHi = personality >> 16;
                if (WasmRunShouldRelease(pidLo, pidHi))
                    WasmRunReleasePid(pidLo, pidHi);
            }
        }
    }

    for (i = 0; i < PARTY_SIZE; i++)
    {
        if (GetMonData(&gPlayerParty[i], MON_DATA_SPECIES) != SPECIES_NONE
            && GetMonData(&gPlayerParty[i], MON_DATA_HP) > 0)
            livingCount++;
    }
    if (livingCount > 0)
        WasmRunSyncPartyLevels();
    WasmRunOnPartyWipe(livingCount == 0);
}

u32 WasmRunFlushPendingReleases(void)
{
    u8 i;
    u8 releasedCount = 0;
    u8 livingCount = 0;

    if (gMain.inBattle || gMain.callback2 != CB2_Overworld || ArePlayerFieldControlsLocked() || IsWallyTutorialPartyActive())
        return 0;

    for (i = 0; i < PARTY_SIZE;)
    {
        struct Pokemon *mon = &gPlayerParty[i];
        u16 species = GetMonData(mon, MON_DATA_SPECIES);
        u32 personality;
        u32 pidLo, pidHi;
        if (species == SPECIES_NONE)
        {
            i++;
            continue;
        }
        personality = GetMonData(mon, MON_DATA_PERSONALITY);
        pidLo = personality & 0xffff;
        pidHi = personality >> 16;
        if (WasmRunShouldRelease(pidLo, pidHi))
        {
            WasmRunReleasePid(pidLo, pidHi);
            releasedCount++;
            continue;
        }
        i++;
    }

    if (gPokemonStoragePtr != NULL)
    {
        u8 box;
        for (box = 0; box < TOTAL_BOXES_COUNT; box++)
        {
            u8 position;
            for (position = 0; position < IN_BOX_COUNT; position++)
            {
                struct BoxPokemon *mon = &gPokemonStoragePtr->boxes[box][position];
                u32 personality;
                u32 pidLo, pidHi;
                if (GetBoxMonData(mon, MON_DATA_SPECIES) == SPECIES_NONE)
                    continue;
                personality = GetBoxMonData(mon, MON_DATA_PERSONALITY);
                pidLo = personality & 0xffff;
                pidHi = personality >> 16;
                if (WasmRunShouldRelease(pidLo, pidHi))
                {
                    WasmRunReleasePid(pidLo, pidHi);
                    releasedCount++;
                }
            }
        }
    }

    if (releasedCount > 0)
    {
        for (i = 0; i < PARTY_SIZE; i++)
        {
            if (GetMonData(&gPlayerParty[i], MON_DATA_SPECIES) != SPECIES_NONE
                && GetMonData(&gPlayerParty[i], MON_DATA_HP) > 0)
                livingCount++;
        }
        WasmRunOnPartyWipe(livingCount == 0);
    }
    return releasedCount;
}
#endif // WASM
