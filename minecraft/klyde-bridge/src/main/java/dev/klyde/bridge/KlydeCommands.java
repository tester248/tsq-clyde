package dev.klyde.bridge;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * The /klyde command tree (permissionless — no LuckPerms requirement).
 *
 *   /klyde                       — help
 *   /klyde privacy <on|off>      — opt out/in of sharing location/chat data
 *   /klyde progress <on|off>     — hide/show Klyde's progress messages
 *   /klyde messages <on|off>     — hide/show all Klyde messages
 */
public final class KlydeCommands {
    private KlydeCommands() {}

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
            register(dispatcher));
    }

    private interface ToggleAction {
        void apply(CommandContext<CommandSourceStack> ctx, boolean on);
    }

    private static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("klyde")
                .then(toggle("privacy", (ctx, on) ->
                    KlydeBridgeMod.get().getPreferences().setPrivacy(sourcePlayerName(ctx), on)))
                .then(toggle("progress", (ctx, on) ->
                    KlydeBridgeMod.get().getPreferences().setShowProgress(sourcePlayerName(ctx), on)))
                .then(toggle("messages", (ctx, on) ->
                    KlydeBridgeMod.get().getPreferences().setShowMessages(sourcePlayerName(ctx), on)))
                .then(Commands.literal("clear").executes(KlydeCommands::clear))
                .executes(ctx -> {
                    ctx.getSource().sendSuccess(() -> Component.literal(
                        "Klyde: /klyde privacy <on|off> · progress <on|off> · messages <on|off> · clear (ops)"), false);
                    return 1;
                })
        );
    }

    // Ops (vanilla permission level 2+) wipe the in-game conversation.
    private static int clear(CommandContext<CommandSourceStack> ctx) {
        String player = sourcePlayerName(ctx);
        if (player == null) {
            ctx.getSource().sendFailure(Component.literal("You must be in-game to clear Klyde's context."));
            return 0;
        }
        ServerPlayer p;
        try {
            p = ctx.getSource().getPlayerOrException();
        } catch (Exception e) {
            return 0;
        }
        if (!p.permissions().hasPermission(
                new net.minecraft.server.permissions.Permission.HasCommandLevel(
                    net.minecraft.server.permissions.PermissionLevel.ADMINS))) {
            ctx.getSource().sendFailure(Component.literal("Only ops can clear Klyde's context."));
            return 0;
        }
        KlydeBridgeMod.get().getClient().clearContext();
        ctx.getSource().sendSuccess(() -> Component.literal("Klyde: context cleared"), false);
        return 1;
    }

    private static LiteralArgumentBuilder<CommandSourceStack> toggle(String name, ToggleAction action) {
        return Commands.literal(name)
            .then(Commands.literal("on").executes(ctx -> applyToggle(ctx, action, true)))
            .then(Commands.literal("off").executes(ctx -> applyToggle(ctx, action, false)));
    }

    private static int applyToggle(CommandContext<CommandSourceStack> ctx, ToggleAction action, boolean on) {
        String player = sourcePlayerName(ctx);
        if (player == null) {
            ctx.getSource().sendFailure(Component.literal("You must be in-game to change Klyde settings."));
            return 0;
        }
        action.apply(ctx, on);
        String what = ctx.getInput().replaceFirst("^klyde ", "");
        ctx.getSource().sendSuccess(() -> Component.literal("Klyde: " + what + " -> " + (on ? "on" : "off")), false);
        return 1;
    }

    private static String sourcePlayerName(CommandContext<CommandSourceStack> ctx) {
        try {
            ServerPlayer player = ctx.getSource().getPlayerOrException();
            return player.getName().getString();
        } catch (Exception e) {
            return null;
        }
    }
}
