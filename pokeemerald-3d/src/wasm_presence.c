#if WASM

// Read-only field adapter for the browser multiplayer presence layer.
//
// This file deliberately owns no sockets, UI or persistence. It exposes a
// small, stable snapshot of the local player avatar so the JavaScript game
// adapter can publish presence without linking the network code into the
// decompilation.

#include "global.h"
#include "constants/global.h"
#include "constants/map_types.h"
#include "event_object_movement.h"
#include "field_camera.h"
#include "field_message_box.h"
#include "fieldmap.h"
#include "palette.h"
#include "script.h"
#include "sprite.h"
#include "start_menu.h"
#include "task.h"

extern u32 WasmDisplaySceneKind(void);
extern void CB2_Overworld(void);
u32 WasmPresenceValid(void);
s32 WasmPresenceScreenY(void);

enum
{
    PRESENCE_ACTIVITY_OVERWORLD,
    PRESENCE_ACTIVITY_DIALOGUE,
    PRESENCE_ACTIVITY_MENU,
    PRESENCE_ACTIVITY_BATTLE,
    PRESENCE_ACTIVITY_CUTSCENE,
    PRESENCE_ACTIVITY_LOADING,
    PRESENCE_ACTIVITY_AWAY,
    PRESENCE_ACTIVITY_UNSUPPORTED,
};

enum
{
    PRESENCE_MOTION_IDLE,
    PRESENCE_MOTION_WALK,
    PRESENCE_MOTION_RUN,
    PRESENCE_MOTION_BIKE,
    PRESENCE_MOTION_SURF,
    PRESENCE_MOTION_JUMP,
};

// Explicit field context. The browser must not infer indoor/battle support from
// the outdoor scene-kind flag, which is zero for every non-enhanced scene.
enum
{
    PRESENCE_FIELD_UNSUPPORTED,
    PRESENCE_FIELD_OUTDOOR,
    PRESENCE_FIELD_INTERIOR,
    PRESENCE_FIELD_BATTLE,
};

static const struct ObjectEvent *PresenceObjectEvent(void)
{
    if (gSaveBlock1Ptr == NULL)
        return NULL;
    if (gPlayerAvatar.objectEventId >= OBJECT_EVENTS_COUNT)
        return NULL;
    return &gObjectEvents[gPlayerAvatar.objectEventId];
}

static const struct Sprite *PresenceSprite(void)
{
    if (gPlayerAvatar.spriteId >= MAX_SPRITES)
        return NULL;
    if (!gSprites[gPlayerAvatar.spriteId].inUse)
        return NULL;
    return &gSprites[gPlayerAvatar.spriteId];
}

static const struct ObjectEventGraphicsInfo *PresenceGraphics(void)
{
    const struct ObjectEvent *objectEvent = PresenceObjectEvent();
    if (objectEvent == NULL)
        return NULL;
    return GetObjectEventGraphicsInfo(objectEvent->graphicsId);
}

static s32 PresenceAbs(s32 value)
{
    return value < 0 ? -value : value;
}

static bool8 PresenceMoving(void)
{
    return gPlayerAvatar.runningState == MOVING
        || gPlayerAvatar.tileTransitionState != T_NOT_MOVING
        || (gPlayerAvatar.flags & PLAYER_AVATAR_FLAG_FORCED_MOVE);
}

// The GBA field keeps the player sprite pinned to the screen centre and scrolls
// the map underneath it. During a step gSaveBlock1Ptr->pos jumps to the
// destination tile immediately, so it cannot be published directly: remote
// clients would see a one-tile snap every step. Integrate the visual pixel
// delta instead. The sprite screen position already contains the camera scroll,
// and subtracting the camera delta cancels it, leaving the player's actual
// world movement (including maps where the camera is clamped at an edge).
static bool8 sPresenceSmoothValid = FALSE;
static s32 sPresenceSmoothX;
static s32 sPresenceSmoothY;
static u16 sPresenceSmoothCamX;
static u16 sPresenceSmoothCamY;
static s32 sPresenceSmoothScreenX;
static s32 sPresenceSmoothScreenY;
static s16 sPresenceSmoothSaveX;
static s16 sPresenceSmoothSaveY;
static u16 sPresenceSmoothGroup;
static u16 sPresenceSmoothNum;
static u32 sPresenceSmoothLayout;

void WasmPresenceRefresh(void)
{
    const struct ObjectEvent *objectEvent;
    const struct Sprite *sprite;
    s32 screenX, screenY, cameraDeltaX, cameraDeltaY;
    s16 stepDx, stepDy;
    bool8 moving;

    if (!WasmPresenceValid())
    {
        sPresenceSmoothValid = FALSE;
        return;
    }

    objectEvent = PresenceObjectEvent();
    sprite = PresenceSprite();
    if (objectEvent == NULL || sprite == NULL)
    {
        sPresenceSmoothValid = FALSE;
        return;
    }

    screenX = sprite->x + sprite->x2 + gSpriteCoordOffsetX;
    screenY = WasmPresenceScreenY();
    moving = PresenceMoving();
    stepDx = objectEvent->currentCoords.x - objectEvent->previousCoords.x;
    stepDy = objectEvent->currentCoords.y - objectEvent->previousCoords.y;

    if (!sPresenceSmoothValid
     || sPresenceSmoothGroup != gSaveBlock1Ptr->location.mapGroup
     || sPresenceSmoothNum != gSaveBlock1Ptr->location.mapNum
     || sPresenceSmoothLayout != gMapHeader.mapLayoutId
     || PresenceAbs(gSaveBlock1Ptr->pos.x - sPresenceSmoothSaveX) > 2
     || PresenceAbs(gSaveBlock1Ptr->pos.y - sPresenceSmoothSaveY) > 2)
    {
        // Start from the step's source tile when the first sample lands in the
        // middle of a walk, otherwise from the current tile. The published
        // coordinate is the bottom-centre ground footpoint of the tile, matching
        // the shared presence contract rather than the tile's top-left corner.
        sPresenceSmoothX = (s32)(gSaveBlock1Ptr->pos.x - stepDx) * 16 + 8;
        sPresenceSmoothY = (s32)(gSaveBlock1Ptr->pos.y - stepDy) * 16 + 16;
        sPresenceSmoothCamX = gTotalCameraPixelOffsetX;
        sPresenceSmoothCamY = gTotalCameraPixelOffsetY;
        sPresenceSmoothScreenX = screenX;
        sPresenceSmoothScreenY = screenY;
        sPresenceSmoothSaveX = gSaveBlock1Ptr->pos.x;
        sPresenceSmoothSaveY = gSaveBlock1Ptr->pos.y;
        sPresenceSmoothGroup = gSaveBlock1Ptr->location.mapGroup;
        sPresenceSmoothNum = gSaveBlock1Ptr->location.mapNum;
        sPresenceSmoothLayout = gMapHeader.mapLayoutId;
        sPresenceSmoothValid = TRUE;
        return;
    }

    cameraDeltaX = -(s16)(u16)(gTotalCameraPixelOffsetX - sPresenceSmoothCamX);
    cameraDeltaY = -(s16)(u16)(gTotalCameraPixelOffsetY - sPresenceSmoothCamY);
    sPresenceSmoothX += cameraDeltaX + (screenX - sPresenceSmoothScreenX);
    sPresenceSmoothY += cameraDeltaY + (screenY - sPresenceSmoothScreenY);

    if (!moving)
    {
        // Remove any accumulated error once the step settles.
        sPresenceSmoothX = (s32)gSaveBlock1Ptr->pos.x * 16 + 8;
        sPresenceSmoothY = (s32)gSaveBlock1Ptr->pos.y * 16 + 16;
    }

    sPresenceSmoothCamX = gTotalCameraPixelOffsetX;
    sPresenceSmoothCamY = gTotalCameraPixelOffsetY;
    sPresenceSmoothScreenX = screenX;
    sPresenceSmoothScreenY = screenY;
    sPresenceSmoothSaveX = gSaveBlock1Ptr->pos.x;
    sPresenceSmoothSaveY = gSaveBlock1Ptr->pos.y;
}

u32 WasmPresenceValid(void)
{
    const struct ObjectEvent *objectEvent = PresenceObjectEvent();

    if (gSaveBlock1Ptr == NULL)
        return FALSE;
    if (gMapHeader.mapType == MAP_TYPE_NONE)
        return FALSE;
    if (objectEvent == NULL || !gObjectEvents[gPlayerAvatar.objectEventId].active)
        return FALSE;
    // Scripts hide the avatar for scripted beats. Treat that as a cutscene
    // anchor case rather than a live pose, so peers freeze a ghost in place.
    if (objectEvent->invisible)
        return FALSE;
    if (PresenceSprite() == NULL || PresenceGraphics() == NULL)
        return FALSE;
    return TRUE;
}

u32 WasmPresenceMapGroup(void)
{
    if (gSaveBlock1Ptr == NULL)
        return 0;
    return (u8)gSaveBlock1Ptr->location.mapGroup;
}

u32 WasmPresenceMapNum(void)
{
    if (gSaveBlock1Ptr == NULL)
        return 0;
    return (u8)gSaveBlock1Ptr->location.mapNum;
}

u32 WasmPresenceMapLayoutId(void)
{
    return gMapHeader.mapLayoutId;
}

u32 WasmPresenceMapType(void)
{
    return gMapHeader.mapType;
}

u32 WasmPresenceMapWidth(void)
{
    return gMapHeader.mapLayout == NULL ? 0 : gMapHeader.mapLayout->width;
}

u32 WasmPresenceMapHeight(void)
{
    return gMapHeader.mapLayout == NULL ? 0 : gMapHeader.mapLayout->height;
}

// Read-only adjacency for cross-border presentation. Presence never writes map
// state; the renderer already walks the same connection table.
u32 WasmPresenceConnectionCount(void)
{
    if (gMapHeader.connections == NULL)
        return 0;
    return gMapHeader.connections->count;
}

static const struct MapConnection *PresenceConnection(u32 index)
{
    if (gMapHeader.connections == NULL || index >= WasmPresenceConnectionCount())
        return NULL;
    return &gMapHeader.connections->connections[index];
}

static const struct MapLayout *PresenceConnectionLayout(u32 index)
{
    const struct MapConnection *connection = PresenceConnection(index);
    const struct MapHeader *header;

    if (connection == NULL)
        return NULL;
    header = GetMapHeaderFromConnection(connection);
    if (header == NULL)
        return NULL;
    return header->mapLayout;
}

u32 WasmPresenceConnectionGroup(u32 index)
{
    const struct MapConnection *connection = PresenceConnection(index);
    return connection == NULL ? 0 : connection->mapGroup;
}

u32 WasmPresenceConnectionNum(u32 index)
{
    const struct MapConnection *connection = PresenceConnection(index);
    return connection == NULL ? 0 : connection->mapNum;
}

u32 WasmPresenceConnectionDirection(u32 index)
{
    const struct MapConnection *connection = PresenceConnection(index);
    return connection == NULL ? 0 : connection->direction;
}

u32 WasmPresenceConnectionOffset(u32 index)
{
    const struct MapConnection *connection = PresenceConnection(index);
    return connection == NULL ? 0 : (u32)connection->offset;
}

u32 WasmPresenceConnectionWidth(u32 index)
{
    const struct MapLayout *layout = PresenceConnectionLayout(index);
    return layout == NULL ? 0 : layout->width;
}

u32 WasmPresenceConnectionHeight(u32 index)
{
    const struct MapLayout *layout = PresenceConnectionLayout(index);
    return layout == NULL ? 0 : layout->height;
}

u32 WasmPresenceFieldKind(void)
{
    if (gSaveBlock1Ptr == NULL)
        return PRESENCE_FIELD_UNSUPPORTED;
    if (gMapHeader.mapType == MAP_TYPE_NONE)
        return PRESENCE_FIELD_UNSUPPORTED;
    // A live battle or a field battle transition owns the screen. Reporting
    // battle here keeps peers out of the field without guessing from sprites.
    if (gMain.inBattle)
        return PRESENCE_FIELD_BATTLE;
    if (WasmDisplaySceneKind() == 2)
        return PRESENCE_FIELD_BATTLE;
    if (gMapHeader.mapType == MAP_TYPE_INDOOR)
        return PRESENCE_FIELD_INTERIOR;
    if (gMapHeader.mapType == MAP_TYPE_SECRET_BASE)
        return PRESENCE_FIELD_UNSUPPORTED;
    return WasmDisplaySceneKind() == 1 ? PRESENCE_FIELD_OUTDOOR : PRESENCE_FIELD_UNSUPPORTED;
}

u32 WasmPresenceActivity(void)
{
    const u32 fieldKind = WasmPresenceFieldKind();

    if (fieldKind == PRESENCE_FIELD_BATTLE)
        return PRESENCE_ACTIVITY_BATTLE;
    // Unknown field kinds stay closed; secret bases are runtime instances.
    if (fieldKind != PRESENCE_FIELD_OUTDOOR && fieldKind != PRESENCE_FIELD_INTERIOR)
        return PRESENCE_ACTIVITY_UNSUPPORTED;
    // The avatar can disappear for a scripted beat while the field is still up.
    // Fades and warps are loads; anything else is a cutscene the adapter can
    // freeze at its last trustworthy footpoint.
    if (!WasmPresenceValid())
        return gPaletteFade.active ? PRESENCE_ACTIVITY_LOADING : PRESENCE_ACTIVITY_CUTSCENE;

    if (!(gPlayerAvatar.flags & PLAYER_AVATAR_FLAG_ON_FOOT))
        return PRESENCE_ACTIVITY_UNSUPPORTED;

    if (gPlayerAvatar.flags & PLAYER_AVATAR_FLAG_CONTROLLABLE)
        return PRESENCE_ACTIVITY_OVERWORLD;
    if (gPlayerAvatar.runningState == MOVING
     || gPlayerAvatar.tileTransitionState != T_NOT_MOVING
     || (gPlayerAvatar.flags & PLAYER_AVATAR_FLAG_FORCED_MOVE))
        return PRESENCE_ACTIVITY_OVERWORLD;

    // Screen transitions are loads even while the old field is still rendered.
    if (gPaletteFade.active)
        return PRESENCE_ACTIVITY_LOADING;
    // Positive menu detection: the start menu runs as a task over the field, and
    // other menus swap the overworld callback. Both freeze the avatar, so they
    // must be checked before the frozen/script fallback.
    if (FuncIsActiveTask(Task_ShowStartMenu) || gMain.callback2 != CB2_Overworld)
        return PRESENCE_ACTIVITY_MENU;
    if (!IsFieldMessageBoxHidden())
        return PRESENCE_ACTIVITY_DIALOGUE;
    // Only a real field-control lock is a cutscene. Some field states leave the
    // controllable flag clear while the player still stands or walks normally,
    // so that flag alone must not imply a scene.
    if (ArePlayerFieldControlsLocked())
        return PRESENCE_ACTIVITY_CUTSCENE;

    return PRESENCE_ACTIVITY_OVERWORLD;
}

u32 WasmPresenceGender(void)
{
    return gPlayerAvatar.gender;
}

// OAM priority of the local avatar, used to decide which background layers are
// drawn in front of remote players in flat-field interiors.
u32 WasmPresenceSpritePriority(void)
{
    const struct Sprite *sprite = PresenceSprite();
    if (sprite == NULL)
        return 2;
    return sprite->oam.priority;
}

u32 WasmPresenceFacing(void)
{
    const struct ObjectEvent *objectEvent = PresenceObjectEvent();
    if (objectEvent == NULL)
        return DIR_SOUTH;
    return objectEvent->facingDirection;
}

u32 WasmPresenceElevation(void)
{
    const struct ObjectEvent *objectEvent = PresenceObjectEvent();
    if (objectEvent == NULL)
        return 0;
    return objectEvent->currentElevation;
}

u32 WasmPresenceJumpPx(void)
{
    const struct Sprite *sprite = PresenceSprite();
    if (sprite == NULL || sprite->y2 >= 0)
        return 0;
    return (u32)(-sprite->y2);
}

u32 WasmPresenceMotion(void)
{
    const struct Sprite *sprite;

    if (!WasmPresenceValid())
        return PRESENCE_MOTION_IDLE;

    if (gPlayerAvatar.flags & (PLAYER_AVATAR_FLAG_MACH_BIKE | PLAYER_AVATAR_FLAG_ACRO_BIKE))
        return PRESENCE_MOTION_BIKE;
    if (gPlayerAvatar.flags & (PLAYER_AVATAR_FLAG_SURFING | PLAYER_AVATAR_FLAG_UNDERWATER))
        return PRESENCE_MOTION_SURF;

    sprite = PresenceSprite();
    if (sprite != NULL && sprite->y2 < 0)
        return PRESENCE_MOTION_JUMP;

    if (gPlayerAvatar.runningState == MOVING
     || gPlayerAvatar.tileTransitionState == T_TILE_TRANSITION)
    {
        if (gPlayerAvatar.flags & PLAYER_AVATAR_FLAG_DASH)
            return PRESENCE_MOTION_RUN;
        return PRESENCE_MOTION_WALK;
    }
    return PRESENCE_MOTION_IDLE;
}

u32 WasmPresenceAnimNum(void)
{
    const struct Sprite *sprite = PresenceSprite();
    return sprite == NULL ? 0 : sprite->animNum;
}

u32 WasmPresenceAnimCmdIndex(void)
{
    const struct Sprite *sprite = PresenceSprite();
    return sprite == NULL ? 0 : sprite->animCmdIndex;
}

u32 WasmPresenceHFlip(void)
{
    const struct Sprite *sprite = PresenceSprite();
    return sprite == NULL ? FALSE : sprite->hFlip;
}

s32 WasmPresenceXPx(void)
{
    if (!sPresenceSmoothValid || gSaveBlock1Ptr == NULL)
        return 0;
    return sPresenceSmoothX;
}

s32 WasmPresenceYPx(void)
{
    if (!sPresenceSmoothValid || gSaveBlock1Ptr == NULL)
        return 0;
    return sPresenceSmoothY;
}

s32 WasmPresenceScreenX(void)
{
    const struct Sprite *sprite = PresenceSprite();
    if (sprite == NULL)
        return 0;
    return sprite->x + sprite->x2 + gSpriteCoordOffsetX;
}

s32 WasmPresenceScreenY(void)
{
    const struct Sprite *sprite = PresenceSprite();
    const struct ObjectEventGraphicsInfo *graphics = PresenceGraphics();
    s32 jumpPx;

    if (sprite == NULL || graphics == NULL)
        return 0;
    jumpPx = sprite->y2 < 0 ? -sprite->y2 : 0;
    return sprite->y + sprite->y2 + jumpPx
         + sprite->centerToCornerVecY + gSpriteCoordOffsetY
         + graphics->height;
}

#endif // WASM
