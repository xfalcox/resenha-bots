# frozen_string_literal: true

module Jobs
  module ResenhaBots
    # Health reconciler. This job does NOT spawn or own browsers — the
    # orchestrator daemon (runit-supervised, self-healing) does that. Here we
    # only observe: read Resenha presence from Redis and warn when a configured
    # bot is missing from its room, so the absence is visible in the logs.
    class Reconcile < ::Jobs::Scheduled
      every 1.minute

      def execute(_args)
        return unless SiteSetting.resenha_bots_enabled
        return unless SiteSetting.resenha_bots_reconcile_enabled
        return unless defined?(::Resenha::ParticipantTracker)

        ::ResenhaBots::Config.bots.each do |bot|
          present =
            ::Resenha::ParticipantTracker.user_ids(bot.room_id).include?(
              bot.user_id
            )
          next if present

          Rails.logger.warn(
            "[resenha-bots] bot #{bot.username} is not present in room #{bot.room_slug} " \
              "(room_id=#{bot.room_id}); orchestrator may be down or mid-cycle"
          )
        end
      end
    end
  end
end
