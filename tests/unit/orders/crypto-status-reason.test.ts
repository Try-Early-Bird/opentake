import {test,expect} from 'vitest';
import {cryptoOrderStatusReason} from '../../../src/shared/crypto-orders';
test('existing rejected orders explain saved categories without exposing arbitrary provider text',()=>{
 expect(cryptoOrderStatusReason('rejected','provider_invalid_request')).toContain('invalid request');
 expect(cryptoOrderStatusReason('rejected','approval_declined')).toContain('declined');
 expect(cryptoOrderStatusReason('rejected','approval_expired')).toContain('expired');
 expect(cryptoOrderStatusReason('rejected','private-provider-value')).not.toContain('private-provider-value');
 expect(cryptoOrderStatusReason('placement_unknown',null)).toContain('not yet verified');
 expect(cryptoOrderStatusReason('placed','private-provider-value')).toBeNull();
});

test('recognized submission reasons explain the provider report without weakening unknown handling',()=>{
 expect(cryptoOrderStatusReason('rejected','provider_invalid_request_buying_power')).toContain('Robinhood reported: insufficient buying power');
 expect(cryptoOrderStatusReason('rejected','provider_invalid_request_region_restricted')).toContain('state or region');
 expect(cryptoOrderStatusReason('placement_unknown','provider_invalid_request_buying_power')).toContain('not yet verified');
 expect(cryptoOrderStatusReason('rejected','provider_invalid_request_private-token')).not.toContain('private-token');
});
