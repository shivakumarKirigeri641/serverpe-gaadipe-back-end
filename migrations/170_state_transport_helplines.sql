-- 170_state_transport_helplines.sql (user, 2026-10-14: "CarInfo shows the respective RTO
-- website and phone number"). The RTO line on a vehicle now links the state's own transport
-- website (site/stateTransport.js, each address checked on 14 Oct) and shows its helpline
-- when this setting has one. JSON by state code; a state without a number shows none.
-- Seeded with the one number found on an official site: Uttar Pradesh's toll-free line
-- (uptransport.upsdc.gov.in). Add others from each state's official site in Settings.
INSERT INTO app_settings (key, value) VALUES ('state_transport_helplines', '{"UP": "1800-180-2877"}')
ON CONFLICT (key) DO NOTHING;
