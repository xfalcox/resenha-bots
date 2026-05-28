# frozen_string_literal: true

module ResenhaBots
  # Returns the normalized bot roster to the out-of-process orchestrator daemon.
  # Admin-only: the daemon authenticates with an admin-scoped API key. This is a
  # demo plugin and intentionally returns bot passwords in the payload.
  class ConfigController < ::ApplicationController
    requires_plugin ResenhaBots::PLUGIN_NAME

    before_action :ensure_logged_in
    before_action :ensure_admin

    def show
      render json: {
               enabled: SiteSetting.resenha_bots_enabled,
               base_url: Discourse.base_url,
               bots: ResenhaBots::Config.bots.map(&:to_h)
             }
    end
  end
end
