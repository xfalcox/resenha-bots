# frozen_string_literal: true

module ResenhaBots
  class Engine < ::Rails::Engine
    engine_name PLUGIN_NAME
    isolate_namespace ResenhaBots
  end
end
