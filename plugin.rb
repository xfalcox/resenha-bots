# frozen_string_literal: true

# name: resenha-bots
# about: Demo-only orchestrator config for headless voice bots that join Resenha rooms and play audio
# version: 0.1
# authors: Discourse Contributors
# url: https://github.com/discourse/resenha-bots

enabled_site_setting :resenha_bots_enabled

# Companion to the `resenha` voice plugin. This plugin holds the bot roster
# (site setting), exposes it to the out-of-process Playwright orchestrator, and
# runs a Sidekiq health reconciler. The browsers themselves live in the
# `orchestrator/` daemon — see README.md.

module ::ResenhaBots
  PLUGIN_NAME = "resenha-bots"
end

require_relative "lib/resenha_bots/engine"

after_initialize do
  require_relative "lib/resenha_bots/config"

  Discourse::Application.routes.append do
    mount ::ResenhaBots::Engine, at: "/resenha-bots"
  end
end
