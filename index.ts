/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 sumfall
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, proxyLazyWebpack } from "@webpack";
import { ChannelStore, FluxDispatcher, Toasts, UserSettingsActionCreators, UserStore } from "@webpack/common";

const logger = new Logger("GifAutoSave");

// Discord proto GIF format enum
const enum GifFormat {
    GIFV = 1, // tenor/giphy (embed type "gifv")
    GIF = 2,  // regular .gif attachment
}

// Same binary read options used by fakeNitro for proto cloning
const BINARY_READ_OPTIONS = findByPropsLazy("readerFactory");

// Mirrors the same helper used in fakeNitro to navigate nested proto classes
function searchProtoClassField(localName: string, protoClass: any) {
    const field = protoClass?.fields?.find((f: any) => f.localName === localName);
    if (!field) return;
    const fieldGetter = Object.values(field).find(v => typeof v === "function") as any;
    return fieldGetter?.();
}

// More specific helper for getting the message class from a map field's values
function getMapValueClass(protoClass: any, fieldName: string) {
    const mapField = protoClass?.fields?.find((f: any) => f.localName === fieldName);
    if (!mapField) return;

    // For protobuf map fields, the value type information is often in a `V` property.
    const valueField = mapField.V;
    if (!valueField) return;

    // The message type is a function on that value type descriptor.
    const valueClassGetter = Object.values(valueField).find(v => typeof v === "function") as any;
    return valueClassGetter?.();
}

const FrecencyActionCreators = proxyLazyWebpack(() => UserSettingsActionCreators.FrecencyUserSettingsActionCreators);
const FavoriteGifsClass = proxyLazyWebpack(() => searchProtoClassField("favoriteGifs", FrecencyActionCreators.ProtoClass));
const FavoriteGifClass = proxyLazyWebpack(() => getMapValueClass(FavoriteGifsClass, "gifs"));

const settings = definePluginSettings({
    saveAttachments: {
        type: OptionType.BOOLEAN,
        description: "Save GIF attachments sent in messages",
        default: true,
    },
    saveEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Save GIFs sent via the GIF picker (tenor, giphy, etc.)",
        default: true,
    },
    onlyDirectMessages: {
        type: OptionType.BOOLEAN,
        description: "Only save GIFs received in DMs",
        default: false,
    },
});

function isGifUrl(url: string): boolean {
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".gif");
    } catch {
        return url.toLowerCase().endsWith(".gif");
    }
}

/** Returns true if the GIF was newly added, false if it was already a favorite. */
function addGifToFavorites(src: string, url: string, format: GifFormat, width: number, height: number): boolean {
    try {
        const currentFavoriteGifs = FrecencyActionCreators.getCurrentValue()?.favoriteGifs;

        // Clone via binary round-trip (same pattern as fakeNitro) so we get a mutable proto with proper repeated fields
        const newFavoriteGifs = currentFavoriteGifs != null
            ? FavoriteGifsClass.fromBinary(FavoriteGifsClass.toBinary(currentFavoriteGifs), BINARY_READ_OPTIONS)
            : FavoriteGifsClass.create();

        const rawGifs = newFavoriteGifs.gifs;
        // `gifs` is a map-like object where the key is the GIF's URL
        if (rawGifs[url]) {
            logger.info("GIF already in favorites, skipping");
            return false;
        }

        const newGif = FavoriteGifClass.create({
            format,
            src,
            url,
            width,
            height,
            order: Math.floor(Date.now() / 1000),
        });

        // Add the new gif to the map
        rawGifs[url] = newGif;

        const proto = FrecencyActionCreators.ProtoClass.create();
        proto.favoriteGifs = newFavoriteGifs;

        FluxDispatcher.dispatch({
            type: "USER_SETTINGS_PROTO_UPDATE",
            local: true,
            partial: true,
            settings: { type: 2, proto },
        });

        logger.info("Dispatched USER_SETTINGS_PROTO_UPDATE successfully");
        return true;
    } catch (err) {
        logger.error("Failed to add GIF to favorites", err);
        return false;
    }
}

function handleMessage(message: any, channelId: string) {
    const currentUser = UserStore.getCurrentUser();
    if (message.author?.id === currentUser?.id) return;

    if (settings.store.onlyDirectMessages) {
        const channel = ChannelStore.getChannel(channelId);
        // type 1 = DM, type 3 = Group DM
        if (!channel || (channel.type !== 1 && channel.type !== 3)) return;
    }

    let saved = 0;

    if (settings.store.saveAttachments) {
        for (const att of (message.attachments ?? [])) {
            if (att.content_type !== "image/gif") continue;
            if (!isGifUrl(att.url)) continue;
            if (addGifToFavorites(att.url, att.url, GifFormat.GIF, att.width ?? 0, att.height ?? 0))
                saved++;
        }
    }

    if (settings.store.saveEmbeds) {
        for (const embed of (message.embeds ?? [])) {
            if (embed.type !== "gifv") continue;
            const pageUrl = embed.url;
            if (!pageUrl) continue;
            const width = embed.thumbnail?.width ?? embed.image?.width ?? 0;
            const height = embed.thumbnail?.height ?? embed.image?.height ?? 0;
            if (addGifToFavorites(pageUrl, pageUrl, GifFormat.GIFV, width, height))
                saved++;
        }
    }


}

export default definePlugin({
    name: "GifAutoSave",
    description: "Automatically saves received GIFs to your Discord GIF favorites",
    authors: [{ name: "sumfall", id: 1340203882533486592n }],
    settings,

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic) return;
            try {
                handleMessage(message, message.channel_id);
            } catch (err) {
                logger.error("Unhandled error in MESSAGE_CREATE", err);
            }
        },
        MESSAGE_UPDATE({ message }: { message: any; }) {
            try {
                handleMessage(message, message.channel_id);
            } catch (err) {
                logger.error("Unhandled error in MESSAGE_UPDATE", err);
            }
        },
    },
});
