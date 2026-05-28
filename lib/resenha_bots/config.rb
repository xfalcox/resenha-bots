# frozen_string_literal: true

module ResenhaBots
  # Parses and normalizes the `resenha_bots_config` site setting into a list of
  # bot definitions, resolving each room slug to its Resenha room id and each
  # username to a user id. Invalid entries are skipped (with a logged warning)
  # rather than aborting the whole roster.
  class Config
    Bot =
      Struct.new(
        :username,
        :user_id,
        :password,
        :room_slug,
        :room_id,
        :audio_url,
        :active_seconds,
        :idle_seconds,
        keyword_init: true
      ) do
        def to_h
          {
            username: username,
            user_id: user_id,
            password: password,
            room_slug: room_slug,
            room_id: room_id,
            audio_url: audio_url,
            active_seconds: active_seconds,
            idle_seconds: idle_seconds
          }
        end
      end

    def self.bots
      new.bots
    end

    def bots
      raw_entries.filter_map { |entry| build_bot(entry) }
    end

    private

    def raw_entries
      parsed = JSON.parse(SiteSetting.resenha_bots_config.presence || "[]")
      return parsed if parsed.is_a?(Array)

      Rails.logger.warn(
        "[resenha-bots] resenha_bots_config is not a JSON array; ignoring"
      )
      []
    rescue JSON::ParserError => e
      Rails.logger.warn(
        "[resenha-bots] resenha_bots_config is not valid JSON: #{e.message}"
      )
      []
    end

    def build_bot(entry)
      return warn_skip("entry is not an object") unless entry.is_a?(Hash)

      username = entry["username"].to_s.strip
      password = entry["password"].to_s
      room_slug = entry["room"].to_s.strip
      audio_url = entry["audio_url"].to_s.strip

      return warn_skip("missing username") if username.blank?
      return warn_skip("missing password for #{username}") if password.blank?
      return warn_skip("missing room for #{username}") if room_slug.blank?
      return warn_skip("missing audio_url for #{username}") if audio_url.blank?

      user = User.find_by(username_lower: username.downcase)
      return warn_skip("unknown user #{username}") unless user

      room = resolve_room(room_slug)
      return warn_skip("unknown room #{room_slug} for #{username}") unless room

      Bot.new(
        username: user.username,
        user_id: user.id,
        password: password,
        room_slug: room_slug,
        room_id: room.id,
        audio_url: audio_url,
        active_seconds:
          positive_int(
            entry["active_seconds"],
            SiteSetting.resenha_bots_default_active_seconds
          ),
        idle_seconds:
          positive_int(
            entry["idle_seconds"],
            SiteSetting.resenha_bots_default_idle_seconds,
            allow_zero: true
          )
      )
    end

    def resolve_room(slug)
      return unless defined?(::Resenha::Room)
      ::Resenha::Room.find_by(slug: slug) ||
        ::Resenha::Room.find_by(id: slug.to_i)
    end

    def positive_int(value, fallback, allow_zero: false)
      int = Integer(value, exception: false)
      return fallback if int.nil?
      return fallback if int.negative?
      return fallback if int.zero? && !allow_zero
      int
    end

    def warn_skip(reason)
      Rails.logger.warn("[resenha-bots] skipping bot entry: #{reason}")
      nil
    end
  end
end
