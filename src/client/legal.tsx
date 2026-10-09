import { useEffect } from 'react';
import type { Lang } from './i18n';

export const REPO = 'https://github.com/jan-be/berlin-streckensammler';
const UPDATED = { de: '9. Oktober 2026', en: '9 October 2026' };

/** The address, put together in the browser rather than sitting in the page as one string for harvesters */
function Mail() {
  const address = ['streckensammler', 'janbe.eu'].join('@');
  return <a href={`mailto:${address}`}>{address}</a>;
}

/**
 * Impressum and privacy policy on one page (/rechtliches; /impressum and
 * /datenschutz jump to their section). Every statement here describes what
 * the code and the server actually do; change it together with them.
 */
export function LegalPage({ lang, section, onBack, backLabel }: { lang: Lang; section?: 'impressum' | 'datenschutz'; onBack: () => void; backLabel: string }) {
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView();
  }, [section]);
  return (
    <article className="legal">
      <button className="back" onClick={onBack}>‹ {backLabel}</button>
      {lang === 'de' ? <German /> : <English />}
    </article>
  );
}

function German() {
  return (
    <>
      <section id="impressum">
        <h1>Impressum</h1>
        <p>Angaben gemäß § 5 DDG und § 18 Abs. 1 MStV</p>
        <p><b>Jan Beckschewe</b><br />E-Mail: <Mail /></p>
        <p>
          Berlin Streckensammler ist ein privates, nicht kommerzielles Projekt ohne Werbung. Der Quellcode ist
          öffentlich: <a href={REPO} target="_blank" rel="noopener noreferrer">github.com/jan-be/berlin-streckensammler</a>.
        </p>
        <h2>Daten und Zeichen</h2>
        <p>
          Haltestellen und Linien stammen aus den Fahrplandaten des VBB Verkehrsverbund Berlin-Brandenburg GmbH
          (GTFS, Lizenz CC BY 4.0) und werden für die App aufbereitet. Sie können Fehler enthalten oder veraltet sein;
          für ihre Richtigkeit und Vollständigkeit wird keine Gewähr übernommen. Die Verkehrszeichen der S-Bahn,
          U-Bahn, Tram, Busse, Fähren und Regionalbahnen stammen von Wikimedia Commons und sind dort als gemeinfrei
          gekennzeichnet. Die App ist nicht mit BVG, S-Bahn Berlin, VBB oder der App „Streckensammler“ verbunden.
        </p>
        <h2>Links</h2>
        <p>
          Für die Inhalte verlinkter Seiten (z. B. OpenStreetMap, GitHub) sind ausschließlich deren Betreiber
          verantwortlich.
        </p>
      </section>

      <section id="datenschutz">
        <h1>Datenschutzerklärung</h1>
        <p className="muted small">Stand: {UPDATED.de}</p>

        <h2>1. Verantwortlicher</h2>
        <p>Jan Beckschewe, E-Mail: <Mail /></p>

        <h2>2. Kurz gesagt</h2>
        <ul>
          <li>Kein Tracking, keine Analyse-Tools, keine Werbung, keine eingebundenen Inhalte Dritter. Alles kommt von einem eigenen Server in Deutschland.</li>
          <li>Ein einziges Cookie: die Anmeldung dieses Browsers. Kein Cookie-Banner nötig, weil es technisch erforderlich ist.</li>
          <li>Kein Konto nötig. Wenn du eins anlegst: nur ein Name und Passkeys, keine E-Mail-Adresse, kein Passwort.</li>
          <li>Dein Standort verlässt nie dein Gerät.</li>
          <li>Du kannst deine Daten jederzeit herunterladen oder löschen.</li>
        </ul>

        <h2>3. Aufruf der Seite</h2>
        <p>
          Die App läuft auf einem eigenen Server in Deutschland; es gibt keinen Hosting-Dienstleister, der Daten in
          unserem Auftrag verarbeitet. Beim Aufruf überträgt dein Browser technisch bedingt deine IP-Adresse, die
          aufgerufene Adresse und Angaben zum Browser. Der Webserver protokolliert jeden Zugriff mit IP-Adresse,
          Zeitpunkt, aufgerufener Adresse, Browser-Kennung (User-Agent) und verweisender Seite (Referrer). Die
          Protokolle dienen der Sicherheit und der Fehlersuche (Art. 6 Abs. 1 lit. f DSGVO).
        </p>

        <h2>4. Besuche eintragen ohne Konto</h2>
        <p>
          Sobald du den ersten Besuch einträgst, legt der Server einen anonymen Nutzer an und setzt das Cookie
          <code>ss_session</code> (zufällige Kennung, nur über HTTPS, für Skripte unlesbar, Laufzeit 400 Tage).
          Gespeichert werden deine Besuche: Station, Verkehrsmittel, Datum und deine freiwillige Notiz, dazu wann
          sie eingetragen wurden. Ohne dieses Cookie ist die Sammlung nicht mehr erreichbar. Rechtsgrundlage ist
          Art. 6 Abs. 1 lit. b DSGVO (die von dir gewünschte Nutzung der App); das Cookie ist dafür unbedingt
          erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG).
        </p>

        <h2>5. Konto mit Passkey</h2>
        <p>
          Für ein Konto speichern wir den Namen, den du wählst, und für jeden Passkey dessen öffentlichen Schlüssel,
          seine Kennung, einen Zähler gegen Kopien, ob er synchronisiert wird, die Kennung des Herstellers
          (AAGUID, z. B. „iCloud“ oder „Google“) sowie wann er angelegt und zuletzt benutzt wurde. Zu jeder Anmeldung
          speichern wir einen Hash der Sitzungskennung, wann sie begann, wann sie zuletzt benutzt wurde und mit
          welchem Passkey. Fingerabdruck, Gesichtsdaten oder Geräte-PIN bleiben auf deinem Gerät; wir erhalten sie
          nie. Deine Besuche werden beim Anlegen des Kontos oder beim Anmelden dem Konto zugeordnet. Dein Name und
          deine Besuche sind für niemanden außer dir sichtbar. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
        </p>

        <h2>6. Standort</h2>
        <p>
          Nur wenn du auf „In der Nähe“ tippst, fragt die App deinen Standort einmal über deinen Browser ab. Die
          Entfernungen werden in deinem Browser berechnet; der Standort wird weder übertragen noch gespeichert.
        </p>

        <h2>7. Speicher im Browser</h2>
        <p>
          Im lokalen Speicher deines Browsers merkt sich die App die Sprache und ob du den Hinweis zum Konto
          ausgeblendet hast. Diese Angaben verlassen dein Gerät nicht.
        </p>

        <h2>8. Externe Links</h2>
        <p>
          „Auf der Karte zeigen“ öffnet OpenStreetMap, der Link zum Quellcode GitHub. Erst wenn du einen solchen Link
          antippst, verbindet sich dein Browser mit diesen Diensten; dann gelten deren Datenschutzerklärungen.
        </p>

        <h2>9. Speicherdauer</h2>
        <p>
          Besuche und Konto bleiben gespeichert, bis du sie löschst: einzelne Besuche in der Station, alles auf einmal
          unter „Konto“. Beim Abmelden wird die Sitzung gelöscht. Eine Weitergabe an Dritte oder in Länder außerhalb
          der EU findet nicht statt, ebenso keine automatisierte Entscheidungsfindung.
        </p>

        <h2>10. Deine Rechte</h2>
        <p>
          Du hast das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung
          der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21). Unter „Konto“ kannst
          du deine gespeicherten Daten als Datei herunterladen und alles löschen; für alles andere schreib an <Mail />.
          Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren, insbesondere in dem
          EU-Mitgliedstaat, in dem du dich aufhältst oder arbeitest (Art. 77 DSGVO).
        </p>
      </section>
    </>
  );
}

function English() {
  return (
    <>
      <section id="impressum">
        <h1>Legal notice (Impressum)</h1>
        <p>Information according to § 5 DDG and § 18(1) MStV (German law)</p>
        <p><b>Jan Beckschewe</b><br />E-mail: <Mail /></p>
        <p>
          Berlin Streckensammler is a private, non-commercial project without ads. Its source code is public:{' '}
          <a href={REPO} target="_blank" rel="noopener noreferrer">github.com/jan-be/berlin-streckensammler</a>.
        </p>
        <h2>Data and signs</h2>
        <p>
          Stops and lines come from the timetable data of VBB Verkehrsverbund Berlin-Brandenburg GmbH (GTFS, licence
          CC BY 4.0), prepared for this app. They may contain errors or be out of date; no guarantee is given for their
          accuracy or completeness. The signs of the S-Bahn, U-Bahn, trams, buses, ferries and regional trains come
          from Wikimedia Commons, where they are marked public domain. The app is not affiliated with BVG, S-Bahn
          Berlin, VBB or the "Streckensammler" app.
        </p>
        <h2>Links</h2>
        <p>The operators of linked sites (e.g. OpenStreetMap, GitHub) are solely responsible for their content.</p>
      </section>

      <section id="datenschutz">
        <h1>Privacy policy</h1>
        <p className="muted small">Last updated: {UPDATED.en}</p>

        <h2>1. Controller</h2>
        <p>Jan Beckschewe, e-mail: <Mail /></p>

        <h2>2. In short</h2>
        <ul>
          <li>No tracking, no analytics, no ads, no embedded third-party content. Everything is served from our own server in Germany.</li>
          <li>One cookie only: this browser's sign-in. No cookie banner, because it is strictly necessary.</li>
          <li>No account needed. If you create one: just a name and passkeys, no e-mail address, no password.</li>
          <li>Your location never leaves your device.</li>
          <li>You can download or delete your data at any time.</li>
        </ul>

        <h2>3. Visiting the site</h2>
        <p>
          The app runs on our own server in Germany; no hosting provider processes data on our behalf. Your browser
          necessarily sends your IP address, the requested address and browser details. The web server logs every
          request with the IP address, time, requested address, browser identification (user agent) and referring
          page (referrer). The logs serve security and troubleshooting (Art. 6(1)(f) GDPR).
        </p>

        <h2>4. Logging visits without an account</h2>
        <p>
          When you log your first visit, the server creates an anonymous user and sets the cookie <code>ss_session</code>
          (a random identifier, HTTPS only, not readable by scripts, valid for 400 days). Stored are your visits:
          station, mode of transport, date and your optional note, plus when each was logged. Without the cookie the
          collection can no longer be reached. Legal basis: Art. 6(1)(b) GDPR (the use of the app you ask for); the
          cookie is strictly necessary for it (§ 25(2) no. 2 TDDDG).
        </p>

        <h2>5. Accounts with passkeys</h2>
        <p>
          For an account we store the name you choose and, for each passkey, its public key, its identifier, a counter
          against copies, whether it is synced, the maker's identifier (AAGUID, e.g. "iCloud" or "Google") and when it
          was created and last used. For each sign-in we store a hash of the session identifier, when it started, when
          it was last used and with which passkey. Fingerprint, face data or device PIN stay on your device; we never
          receive them. Your visits become the account's when you create it or sign in. Your name and your visits are
          visible to nobody but you. Legal basis: Art. 6(1)(b) GDPR.
        </p>

        <h2>6. Location</h2>
        <p>
          Only when you tap "Nearby" does the app ask your browser for your location, once. Distances are worked out
          in your browser; the location is neither sent nor stored.
        </p>

        <h2>7. Browser storage</h2>
        <p>
          The app keeps your language and whether you dismissed the account hint in your browser's local storage.
          This never leaves your device.
        </p>

        <h2>8. External links</h2>
        <p>
          "Show on map" opens OpenStreetMap, the source code link opens GitHub. Your browser connects to these services
          only when you tap such a link; their privacy policies then apply.
        </p>

        <h2>9. How long data is kept</h2>
        <p>
          Visits and accounts are kept until you delete them: single visits in the station, everything at once under
          "Account". Signing out deletes the session. Nothing is passed to third parties or outside the EU, and there
          is no automated decision-making.
        </p>

        <h2>10. Your rights</h2>
        <p>
          You have the right of access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of
          processing (Art. 18), data portability (Art. 20) and to object (Art. 21). Under "Account" you can download
          your stored data as a file and delete it all; for anything else write to <Mail />. You may also lodge a
          complaint with a data protection supervisory authority, in particular in the EU member state where you live
          or work (Art. 77 GDPR).
        </p>
      </section>
    </>
  );
}
