# frozen_string_literal: true

ResenhaBots::Engine.routes.draw { get "/config" => "config#show" }
