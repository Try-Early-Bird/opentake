import {robinhoodProfile} from './registry';
import type {VenueModule} from './types';

// Robinhood as a venue module. Its rule-trade adapters (rebalance
// and reduce) are registered by the host; without them every action is `action_unsupported`.
export const robinhoodVenue:VenueModule={profile:robinhoodProfile,adapters:{}};
export const robinhoodVenueWith=(adapters:VenueModule['adapters']):VenueModule=>({profile:robinhoodProfile,adapters});
