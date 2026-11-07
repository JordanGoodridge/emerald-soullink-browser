#include "global.h"
#include "item.h"
#include "pokemon.h"
#include "pokemon_storage_system.h"
#include "event_data.h"
#include "wasm/run.h"
#include "constants/flags.h"
#include "constants/items.h"

#if WASM
extern u16 WasmRunRandomSpecies(u32 kind, u16 originalSpecies, u32 contextA, u32 contextB);

u32 WasmRunDebugSetBadgeCount(u32 count)
{
    u8 badge;
    if (count > NUM_BADGES)
        return 0;
    for (badge = 0; badge < NUM_BADGES; badge++)
    {
        if (badge < count)
            FlagSet(FLAG_BADGE01_GET + badge);
        else
            FlagClear(FLAG_BADGE01_GET + badge);
    }
    return WasmRunGymLevelCap();
}

u32 WasmRunDebugFaintPartySlot(u32 index)
{
    u16 hp = 0;
    if (index >= PARTY_SIZE || GetMonData(&gPlayerParty[index], MON_DATA_SPECIES) == SPECIES_NONE)
        return FALSE;
    SetMonData(&gPlayerParty[index], MON_DATA_HP, &hp);
    return TRUE;
}

u32 WasmRunDebugAddItem(u16 itemId, u16 quantity)
{
    if (itemId == ITEM_NONE || quantity == 0)
        return FALSE;
    return AddBagItem(itemId, quantity);
}

u32 WasmRunDebugAddPartyMon(u32 species, u32 level, u32 personality)
{
    u8 count = CalculatePlayerPartyCount();
    if (count >= PARTY_SIZE || species == SPECIES_NONE || species >= NUM_SPECIES
        || level == 0 || level > MAX_LEVEL)
        return FALSE;
    CreateMon(&gPlayerParty[count], species, level, USE_RANDOM_IVS, TRUE,
        personality, OT_ID_PLAYER_ID, 0);
    CalculatePlayerPartyCount();
    return TRUE;
}

u32 WasmRunDebugAddBoxMon(u32 species, u32 level, u32 pidLo, u32 pidHi)
{
    u8 box;
    u32 personality = (pidLo & 0xffff) | ((pidHi & 0xffff) << 16);
    if (gPokemonStoragePtr == NULL || species == SPECIES_NONE || species >= NUM_SPECIES
        || level == 0 || level > MAX_LEVEL)
        return FALSE;
    for (box = 0; box < TOTAL_BOXES_COUNT; box++)
    {
        u8 position;
        for (position = 0; position < IN_BOX_COUNT; position++)
        {
            struct BoxPokemon *mon = &gPokemonStoragePtr->boxes[box][position];
            if (GetBoxMonData(mon, MON_DATA_SPECIES) != SPECIES_NONE)
                continue;
            CreateBoxMon(mon, species, level, USE_RANDOM_IVS, TRUE, personality, OT_ID_PLAYER_ID, 0);
            return TRUE;
        }
    }
    return FALSE;
}

u32 WasmRunDebugBoxHasPid(u32 pidLo, u32 pidHi)
{
    u32 personality = (pidLo & 0xffff) | ((pidHi & 0xffff) << 16);
    u8 box;
    if (gPokemonStoragePtr == NULL)
        return FALSE;
    for (box = 0; box < TOTAL_BOXES_COUNT; box++)
    {
        u8 position;
        for (position = 0; position < IN_BOX_COUNT; position++)
        {
            struct BoxPokemon *mon = &gPokemonStoragePtr->boxes[box][position];
            if (GetBoxMonData(mon, MON_DATA_SPECIES) != SPECIES_NONE
                && GetBoxMonData(mon, MON_DATA_PERSONALITY) == personality)
                return TRUE;
        }
    }
    return FALSE;
}

u32 WasmRunDebugAllowCapture(u32 areaKey, u16 species, u32 pidLo, u32 pidHi)
{
    return WasmRunAllowCapture(areaKey, species, pidLo, pidHi);
}

u32 WasmRunDebugUseItemEffect(u32 index, u16 itemId)
{
    if (index >= PARTY_SIZE || GetMonData(&gPlayerParty[index], MON_DATA_SPECIES) == SPECIES_NONE)
        return FALSE;
    return !PokemonUseItemEffects(&gPlayerParty[index], itemId, index, 0, FALSE);
}

u32 WasmRunDebugConsumeAndRefillRareCandy(void)
{
    if (!RemoveBagItem(ITEM_RARE_CANDY, 1))
        return FALSE;
    return WasmRunRefillRareCandy();
}

u32 WasmRunDebugRandomSpecies(u32 kind, u16 originalSpecies, u32 contextA, u32 contextB)
{
    return WasmRunRandomSpecies(kind, originalSpecies, contextA, contextB);
}

u32 WasmRunDebugSetChampion(u32 isChampion)
{
    if (isChampion)
    {
        FlagSet(FLAG_IS_CHAMPION);
        FlagSet(FLAG_SYS_GAME_CLEAR);
    }
    else
    {
        FlagClear(FLAG_IS_CHAMPION);
        FlagClear(FLAG_SYS_GAME_CLEAR);
    }
    return WasmRunIsChampion();
}
#endif // WASM
