--
-- PostgreSQL database dump
--

\restrict ZuTT5v8YTYzMtKWq70d0gkNuGdRU0paPlHKUMtzblcYz2cIg5JJ8HVGULeAI8MJ

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: get_times_for_most_recent_visible_comments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_times_for_most_recent_visible_comments() RETURNS TABLE(zid integer, modified bigint)
    LANGUAGE sql
    AS $$
    select zid, max(modified) from (select comments.*, conversations.strict_moderation from comments left join conversations on comments.zid = conversations.zid) as c where c.mod >= (CASE WHEN c.strict_moderation=TRUE then 1 else 0 END) group by c.zid order by c.zid;
$$;


--
-- Name: get_visible_comments(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_visible_comments(the_zid integer) RETURNS TABLE(tid integer, mod integer, strict_moderation boolean)
    LANGUAGE sql
    AS $$
    select comments.tid, comments.mod, conversations.strict_moderation from comments left join conversations on comments.zid = conversations.zid where active = true and mod >= (CASE WHEN strict_moderation=TRUE then 1 else 0 END) and comments.zid = the_zid;
$$;


--
-- Name: now_as_millis(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.now_as_millis() RETURNS bigint
    LANGUAGE plpgsql
    AS $$
        DECLARE
            temp TIMESTAMP := now();
        BEGIN
            -- NOTE: milliseconds includes the seconds, so subtracting seconds from milliseconds
            -- SEE: http://www.postgresql.org/docs/8.4/static/functions-datetime.html
            RETURN 1000*FLOOR(EXTRACT(EPOCH FROM temp)) + FLOOR(EXTRACT(MILLISECONDS FROM temp)) - 1000*FLOOR(EXTRACT(SECOND FROM temp));
        END;
$$;


--
-- Name: pid_auto(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pid_auto() RETURNS trigger
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE
    _magic_id constant int := 873791983; -- This is a magic key used for locking conversation row-sets within the participants table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the participants table, limited to this conversation
    PERFORM pg_advisory_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(pid) + 1, 0) -- Start with comment id of 0
    INTO    NEW.pid
    FROM    participants
    WHERE   zid = NEW.zid;

    -- Duplicate participant_count to the conversations table to speed up conversationsView queries.
    UPDATE conversations
    SET participant_count = NEW.pid + 1
    WHERE zid = NEW.zid;

    RETURN NEW;
END;
$$;


--
-- Name: pid_auto_unlock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pid_auto_unlock() RETURNS trigger
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE
    _magic_id constant int := 873791983;
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Release the lock.
    PERFORM pg_advisory_unlock(_magic_id, _conversation_id);

    RETURN NEW;
END;
$$;


--
-- Name: random_polis_site_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.random_polis_site_id() RETURNS text
    LANGUAGE sql
    AS $$
-- 18 so it's 32 long, not much thought went into this so far
SELECT 'polis_site_id_' || random_string(18);
$$;


--
-- Name: random_string(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.random_string(integer) RETURNS text
    LANGUAGE sql
    AS $_$
SELECT array_to_string(
    ARRAY (
        SELECT substring(
            '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
            FROM (ceil(random()*62))::int FOR 1
        )
        FROM generate_series(1, $1)
    ),
    ''
)
$_$;


--
-- Name: tid_auto(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tid_auto() RETURNS trigger
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE
    _magic_id constant int := 873791984; -- This is a magic key used for locking conversation row-sets within the comments table. TODO keep track of these
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Obtain an advisory lock on the comments table, limited to this conversation
    PERFORM pg_advisory_lock(_magic_id, _conversation_id);

    SELECT  COALESCE(MAX(tid) + 1, 0) -- Start with comment id of 0
    INTO    NEW.tid
    FROM    comments
    WHERE   zid = NEW.zid;

    RETURN NEW;
END;
$$;


--
-- Name: tid_auto_unlock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tid_auto_unlock() RETURNS trigger
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE
    _magic_id constant int := 873791984;
    _conversation_id int;
BEGIN
    _conversation_id = NEW.zid;

    -- Release the lock.
    PERFORM pg_advisory_unlock(_magic_id, _conversation_id);

    RETURN NEW;
END;
$$;


--
-- Name: to_millis(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.to_millis(t timestamp with time zone) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RETURN 1000*FLOOR(EXTRACT(EPOCH FROM t)) + FLOOR(EXTRACT(MILLISECONDS FROM t)) - 1000*FLOOR(EXTRACT(SECOND FROM t));
        END;
$$;


--
-- Name: to_zid(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.to_zid(associated_zinvite text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RETURN (select zid from zinvites where zinvite = associated_zinvite);
        END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: apikeysndvweifu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apikeysndvweifu (
    uid integer NOT NULL,
    apikey character varying(32) NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_tokens (
    token character varying(32),
    uid integer,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: beta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beta (
    name character varying(999),
    email character varying(200),
    organization character varying(200),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: comment_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_translations (
    zid integer NOT NULL,
    tid integer NOT NULL,
    src integer NOT NULL,
    txt character varying(9999) NOT NULL,
    lang character varying(10) NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    tid integer NOT NULL,
    zid integer NOT NULL,
    pid integer NOT NULL,
    uid integer NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis(),
    txt character varying(1000) NOT NULL,
    velocity real DEFAULT 1 NOT NULL,
    mod integer DEFAULT 0 NOT NULL,
    lang character varying(10),
    lang_confidence real,
    active boolean DEFAULT true NOT NULL,
    is_meta boolean DEFAULT false NOT NULL,
    tweet_id bigint,
    quote_src_url character varying(1000),
    anon boolean DEFAULT false NOT NULL,
    is_seed boolean DEFAULT false NOT NULL
);


--
-- Name: contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contexts (
    context_id integer NOT NULL,
    name character varying(300),
    creator integer,
    is_public boolean DEFAULT false,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: contexts_context_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contexts_context_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contexts_context_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contexts_context_id_seq OWNED BY public.contexts.context_id;


--
-- Name: contributer_agreement_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contributer_agreement_signatures (
    uid integer,
    name character varying(746) NOT NULL,
    company_name character varying(746),
    github_id character varying(256),
    email character varying(256) NOT NULL,
    agreement_version integer NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: conversation_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_translations (
    zid integer NOT NULL,
    src integer NOT NULL,
    topic character varying(9999) NOT NULL,
    description character varying(9999) NOT NULL,
    lang character varying(10) NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    zid integer NOT NULL,
    topic character varying(1000),
    description character varying(50000),
    link_url character varying(9999),
    parent_url character varying(9999),
    upvotes integer DEFAULT 1 NOT NULL,
    participant_count integer DEFAULT 0,
    is_anon boolean DEFAULT true,
    is_active boolean DEFAULT false,
    is_draft boolean DEFAULT false,
    is_public boolean DEFAULT true,
    is_data_open boolean DEFAULT false,
    profanity_filter boolean DEFAULT true,
    spam_filter boolean DEFAULT true,
    strict_moderation boolean DEFAULT false,
    prioritize_seed boolean DEFAULT false,
    vis_type integer DEFAULT 0 NOT NULL,
    write_type integer DEFAULT 1 NOT NULL,
    help_type integer DEFAULT 1 NOT NULL,
    write_hint_type integer DEFAULT 1 NOT NULL,
    style_btn character varying(500),
    socialbtn_type integer DEFAULT 0 NOT NULL,
    subscribe_type integer DEFAULT 1 NOT NULL,
    branding_type integer DEFAULT 1 NOT NULL,
    bgcolor character varying(20),
    help_bgcolor character varying(20),
    help_color character varying(20),
    email_domain character varying(200),
    use_xid_whitelist boolean DEFAULT false,
    owner integer,
    org_id integer,
    context character varying(1000),
    course_id integer,
    owner_sees_participation_stats boolean DEFAULT false,
    auth_needed_to_vote boolean,
    auth_needed_to_write boolean,
    auth_opt_fb boolean,
    auth_opt_tw boolean,
    auth_opt_allow_3rdparty boolean,
    modified bigint DEFAULT public.now_as_millis(),
    created bigint DEFAULT public.now_as_millis(),
    importance_enabled boolean DEFAULT false NOT NULL,
    treevite_enabled boolean DEFAULT false,
    xid_required boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN conversations.treevite_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.conversations.treevite_enabled IS 'Enable wave-based invite (Treevite) for this conversation';


--
-- Name: conversations_zid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversations_zid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversations_zid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversations_zid_seq OWNED BY public.conversations.zid;


--
-- Name: courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.courses (
    course_id integer NOT NULL,
    topic character varying(1000),
    description character varying(1000),
    owner integer,
    course_invite character varying(32),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: courses_course_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.courses_course_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: courses_course_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.courses_course_id_seq OWNED BY public.courses.course_id;


--
-- Name: crowd_mod; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crowd_mod (
    zid integer NOT NULL,
    pid integer NOT NULL,
    tid integer NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    as_important boolean,
    as_factual boolean,
    as_feeling boolean,
    as_notmyfeeling boolean,
    as_notgoodidea boolean,
    as_notfact boolean,
    as_unsure boolean,
    as_spam boolean,
    as_abusive boolean,
    as_offtopic boolean
);


--
-- Name: demographic_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demographic_data (
    uid integer,
    fb_gender integer,
    ms_birth_year_estimate_fb integer,
    ms_gender_estimate_fb integer,
    fb_timestamp bigint DEFAULT public.now_as_millis(),
    ms_fb_timestamp bigint DEFAULT public.now_as_millis(),
    ms_response character varying(9999),
    gender_guess integer,
    birth_year_guess integer
);


--
-- Name: einvites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvites (
    einvite character varying(100) NOT NULL,
    email character varying(999),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: email_validations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_validations (
    email character varying(999),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: event_ptpt_no_more_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_ptpt_no_more_comments (
    zid integer NOT NULL,
    pid integer NOT NULL,
    votes_placed smallint NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: facebook_friends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facebook_friends (
    uid integer NOT NULL,
    friend integer NOT NULL
);


--
-- Name: facebook_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facebook_users (
    uid integer NOT NULL,
    fb_user_id text,
    fb_name character varying(9999),
    fb_link character varying(9999),
    fb_public_profile text,
    fb_login_status text,
    fb_auth_response text,
    fb_access_token text,
    fb_granted_scopes text,
    fb_location_id character varying(100),
    location character varying(9999),
    response text,
    fb_friends_response text,
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: inviters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inviters (
    inviter_uid integer,
    invited_email character varying(999),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: jianiuevyew; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jianiuevyew (
    uid integer NOT NULL,
    pwhash character varying(128) NOT NULL
);


--
-- Name: math_bidtopid; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_bidtopid (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    math_tick bigint DEFAULT '-1'::integer NOT NULL,
    data jsonb NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_cache (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    data jsonb NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_exportstatus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_exportstatus (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    filename character varying(9999) NOT NULL,
    data jsonb NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_main; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_main (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    data jsonb NOT NULL,
    last_vote_timestamp bigint NOT NULL,
    caching_tick bigint DEFAULT 0 NOT NULL,
    math_tick bigint DEFAULT '-1'::integer NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_profile (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    data jsonb NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_ptptstats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_ptptstats (
    zid integer NOT NULL,
    math_env character varying(999) NOT NULL,
    math_tick bigint DEFAULT '-1'::integer NOT NULL,
    data jsonb NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_report_correlationmatrix; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_report_correlationmatrix (
    rid bigint NOT NULL,
    math_env character varying(999) NOT NULL,
    data jsonb,
    math_tick bigint DEFAULT '-1'::integer NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: math_ticks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.math_ticks (
    zid integer,
    math_tick bigint DEFAULT 0 NOT NULL,
    caching_tick bigint DEFAULT 0 NOT NULL,
    math_env character varying(999) NOT NULL,
    modified bigint DEFAULT public.now_as_millis() NOT NULL
);


--
-- Name: metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics (
    uid integer,
    type integer NOT NULL,
    dur integer,
    hashedpc integer,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: notification_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_tasks (
    zid integer NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: oidc_user_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_user_mappings (
    oidc_sub character varying(255) NOT NULL,
    uid integer NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: COLUMN oidc_user_mappings.oidc_sub; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oidc_user_mappings.oidc_sub IS 'OIDC subject (sub) claim from JWT';


--
-- Name: COLUMN oidc_user_mappings.uid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oidc_user_mappings.uid IS 'Local Polis user ID';


--
-- Name: COLUMN oidc_user_mappings.created; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oidc_user_mappings.created IS 'Timestamp when mapping was created';


--
-- Name: oinvites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oinvites (
    oinvite character varying(300) NOT NULL,
    note character varying(999),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: page_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_ids (
    site_id character varying(100) NOT NULL,
    page_id character varying(100) NOT NULL,
    zid integer NOT NULL
);


--
-- Name: participant_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participant_locations (
    zid integer NOT NULL,
    uid integer NOT NULL,
    pid integer NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    source integer NOT NULL
);


--
-- Name: participant_metadata_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participant_metadata_answers (
    pmaid integer NOT NULL,
    pmqid integer,
    zid integer,
    value character varying(999),
    alive boolean DEFAULT true,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: participant_metadata_answers_pmaid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.participant_metadata_answers_pmaid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: participant_metadata_answers_pmaid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.participant_metadata_answers_pmaid_seq OWNED BY public.participant_metadata_answers.pmaid;


--
-- Name: participant_metadata_choices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participant_metadata_choices (
    zid integer,
    pid integer,
    pmqid integer,
    pmaid integer,
    alive boolean DEFAULT true,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: participant_metadata_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participant_metadata_questions (
    pmqid integer NOT NULL,
    zid integer,
    key character varying(999),
    alive boolean DEFAULT true,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: participant_metadata_questions_pmqid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.participant_metadata_questions_pmqid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: participant_metadata_questions_pmqid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.participant_metadata_questions_pmqid_seq OWNED BY public.participant_metadata_questions.pmqid;


--
-- Name: participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participants (
    pid integer NOT NULL,
    uid integer NOT NULL,
    zid integer NOT NULL,
    vote_count integer DEFAULT 0 NOT NULL,
    last_interaction bigint DEFAULT 0 NOT NULL,
    subscribed integer DEFAULT 0 NOT NULL,
    last_notified bigint DEFAULT 0,
    nsli smallint DEFAULT 0 NOT NULL,
    mod integer DEFAULT 0 NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: participants_extended; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participants_extended (
    uid integer NOT NULL,
    zid integer NOT NULL,
    referrer character varying(9999),
    parent_url character varying(9999),
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis() NOT NULL,
    subscribe_email character varying(256),
    show_translation_activated boolean,
    permanent_cookie character varying(32),
    origin character varying(9999)
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    uid integer,
    created bigint DEFAULT public.now_as_millis(),
    token character varying(250)
);


--
-- Name: permanentcookiezidjoins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permanentcookiezidjoins (
    zid integer NOT NULL,
    cookie character varying(32),
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: pwreset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pwreset_tokens (
    uid integer,
    created bigint DEFAULT public.now_as_millis(),
    token character varying(250)
);


--
-- Name: report_comment_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_comment_selections (
    zid integer NOT NULL,
    rid bigint NOT NULL,
    tid integer NOT NULL,
    selection smallint NOT NULL,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    rid bigint NOT NULL,
    report_id character varying(300) NOT NULL,
    zid integer NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis(),
    report_name character varying(999),
    label_x_neg character varying(999),
    label_x_pos character varying(999),
    label_y_neg character varying(999),
    label_y_pos character varying(999),
    label_group_0 character varying(999),
    label_group_1 character varying(999),
    label_group_2 character varying(999),
    label_group_3 character varying(999),
    label_group_4 character varying(999),
    label_group_5 character varying(999),
    label_group_6 character varying(999),
    label_group_7 character varying(999),
    label_group_8 character varying(999),
    label_group_9 character varying(999),
    mod_level smallint DEFAULT '-2'::integer NOT NULL
);


--
-- Name: reports_rid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reports_rid_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_rid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reports_rid_seq OWNED BY public.reports.rid;


--
-- Name: site_domain_whitelist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_domain_whitelist (
    site_id character varying(256) NOT NULL,
    domain_whitelist character varying(999),
    domain_whitelist_override_key character varying(999),
    modified bigint DEFAULT public.now_as_millis() NOT NULL,
    created bigint DEFAULT public.now_as_millis() NOT NULL
);


--
-- Name: social_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_settings (
    uid integer NOT NULL,
    polis_pic character varying(3000)
);


--
-- Name: stars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stars (
    zid integer NOT NULL,
    pid integer NOT NULL,
    tid integer NOT NULL,
    starred integer NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: suzinvites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suzinvites (
    owner integer NOT NULL,
    zid integer NOT NULL,
    xid text NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    suzinvite character varying(32)
);


--
-- Name: topic_agenda_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topic_agenda_selections (
    zid integer NOT NULL,
    pid integer NOT NULL,
    archetypal_selections jsonb DEFAULT '[]'::jsonb NOT NULL,
    delphi_job_id text,
    total_selections integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE topic_agenda_selections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.topic_agenda_selections IS 'Stores user topic agenda selections as archetypal comments that persist across Delphi runs';


--
-- Name: COLUMN topic_agenda_selections.zid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.topic_agenda_selections.zid IS 'Conversation ID (foreign key to conversations)';


--
-- Name: COLUMN topic_agenda_selections.pid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.topic_agenda_selections.pid IS 'Participant ID (foreign key to participants)';


--
-- Name: COLUMN topic_agenda_selections.archetypal_selections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.topic_agenda_selections.archetypal_selections IS 'JSON array of selected topics with their archetypal comments';


--
-- Name: COLUMN topic_agenda_selections.delphi_job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.topic_agenda_selections.delphi_job_id IS 'ID of the Delphi job that generated the topics';


--
-- Name: COLUMN topic_agenda_selections.total_selections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.topic_agenda_selections.total_selections IS 'Total number of topics selected by the user';


--
-- Name: trashes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trashes (
    zid integer NOT NULL,
    pid integer NOT NULL,
    tid integer NOT NULL,
    trashed integer NOT NULL,
    created bigint DEFAULT public.now_as_millis()
);


--
-- Name: treevite_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treevite_invites (
    id bigint NOT NULL,
    zid integer NOT NULL,
    wave_id bigint NOT NULL,
    parent_invite_id bigint,
    invite_code character varying(64) NOT NULL,
    status smallint DEFAULT 0 NOT NULL,
    invite_owner_pid integer,
    invite_used_by_pid integer,
    invite_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT treevite_invites_status_check CHECK ((status = ANY (ARRAY[0, 1, 2, 3])))
);


--
-- Name: TABLE treevite_invites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.treevite_invites IS 'Per-invite records for Treevite, including ownership, usage, and parent-child edges';


--
-- Name: COLUMN treevite_invites.invite_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_invites.invite_code IS 'Code shared by participants to grant access; unique per conversation';


--
-- Name: COLUMN treevite_invites.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_invites.status IS '0=unused, 1=used, 2=revoked, 3=expired';


--
-- Name: COLUMN treevite_invites.invite_owner_pid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_invites.invite_owner_pid IS 'PID of participant who owns/distributes this invite (NULL for root invites)';


--
-- Name: COLUMN treevite_invites.invite_used_by_pid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_invites.invite_used_by_pid IS 'PID of participant who consumed the invite (NULL until used)';


--
-- Name: treevite_invites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.treevite_invites_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: treevite_invites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.treevite_invites_id_seq OWNED BY public.treevite_invites.id;


--
-- Name: treevite_login_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treevite_login_codes (
    id bigint NOT NULL,
    zid integer NOT NULL,
    pid integer NOT NULL,
    login_code_hash text NOT NULL,
    login_code_fingerprint character varying(128) NOT NULL,
    login_code_lookup character varying(128),
    fp_kid smallint DEFAULT 1 NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE treevite_login_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.treevite_login_codes IS 'Per-participant Treevite login codes: salted hash for verification plus HMAC fingerprint for lookup';


--
-- Name: COLUMN treevite_login_codes.login_code_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_login_codes.login_code_hash IS 'Slow salted hash (argon2/bcrypt) of the participant login code; the raw code is never stored';


--
-- Name: COLUMN treevite_login_codes.login_code_fingerprint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_login_codes.login_code_fingerprint IS 'Indexable HMAC-derived fingerprint scoped by conversation for fast lookup';


--
-- Name: COLUMN treevite_login_codes.login_code_lookup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_login_codes.login_code_lookup IS 'Peppered SHA-256 of login_code for O(1) lookup; verify with bcrypt hash after lookup';


--
-- Name: treevite_login_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.treevite_login_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: treevite_login_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.treevite_login_codes_id_seq OWNED BY public.treevite_login_codes.id;


--
-- Name: treevite_waves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treevite_waves (
    id bigint NOT NULL,
    zid integer NOT NULL,
    wave integer NOT NULL,
    parent_wave integer,
    size integer,
    invites_per_user integer NOT NULL,
    owner_invites integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT treevite_waves_invites_per_user_check CHECK ((invites_per_user >= 0)),
    CONSTRAINT treevite_waves_not_both_zero CHECK (((invites_per_user > 0) OR (owner_invites > 0))),
    CONSTRAINT treevite_waves_owner_invites_check CHECK ((owner_invites >= 0)),
    CONSTRAINT treevite_waves_parent_wave_check CHECK (((parent_wave IS NULL) OR (parent_wave >= 0))),
    CONSTRAINT treevite_waves_size_check CHECK (((size IS NULL) OR (size >= 0))),
    CONSTRAINT treevite_waves_wave_check CHECK ((wave >= 1))
);


--
-- Name: TABLE treevite_waves; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.treevite_waves IS 'Per-wave configuration and summary for Treevite invites';


--
-- Name: COLUMN treevite_waves.wave; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_waves.wave IS 'Wave number (1-based); unique per conversation';


--
-- Name: COLUMN treevite_waves.parent_wave; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_waves.parent_wave IS 'Parent wave number for deriving next wave; 0 for root, NULL means default to greatest existing wave for this zid or 0 if none';


--
-- Name: COLUMN treevite_waves.size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_waves.size IS 'Optional cached size of the wave; derived as (parent_size or 1) * invites_per_user + owner_invites';


--
-- Name: COLUMN treevite_waves.invites_per_user; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_waves.invites_per_user IS 'Number of invites granted to each participant in this wave';


--
-- Name: COLUMN treevite_waves.owner_invites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.treevite_waves.owner_invites IS 'Number of owner-controlled invites added to this wave';


--
-- Name: treevite_waves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.treevite_waves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: treevite_waves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.treevite_waves_id_seq OWNED BY public.treevite_waves.id;


--
-- Name: twitter_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twitter_users (
    uid integer NOT NULL,
    twitter_user_id bigint NOT NULL,
    screen_name character varying(999) NOT NULL,
    name character varying(9999),
    followers_count integer NOT NULL,
    friends_count integer NOT NULL,
    verified boolean NOT NULL,
    profile_image_url_https character varying(9999),
    location character varying(9999),
    response json,
    modified bigint DEFAULT public.now_as_millis() NOT NULL,
    created bigint DEFAULT public.now_as_millis() NOT NULL
);


--
-- Name: upvotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upvotes (
    uid integer,
    zid integer
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    uid integer NOT NULL,
    hname character varying(746),
    created bigint DEFAULT public.now_as_millis(),
    username character varying(128),
    email character varying(256),
    is_owner boolean DEFAULT false,
    zinvite character varying(300),
    oinvite character varying(300),
    tut smallint DEFAULT 0,
    site_id character varying(256) DEFAULT public.random_polis_site_id() NOT NULL,
    site_owner boolean DEFAULT true
);


--
-- Name: users_uid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_uid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_uid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_uid_seq OWNED BY public.users.uid;


--
-- Name: votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.votes (
    zid integer NOT NULL,
    pid integer NOT NULL,
    tid integer NOT NULL,
    vote smallint,
    weight_x_32767 smallint DEFAULT 0,
    created bigint DEFAULT public.now_as_millis(),
    high_priority boolean DEFAULT false NOT NULL
);


--
-- Name: votes_latest_unique; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.votes_latest_unique (
    zid integer NOT NULL,
    pid integer NOT NULL,
    tid integer NOT NULL,
    vote smallint,
    weight_x_32767 smallint DEFAULT 0,
    modified bigint DEFAULT public.now_as_millis()
);


--
-- Name: worker_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_tasks (
    created bigint DEFAULT public.now_as_millis(),
    math_env character varying(999) NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    task_data jsonb NOT NULL,
    task_type character varying(99),
    task_bucket bigint,
    finished_time bigint
);


--
-- Name: xid_whitelist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xid_whitelist (
    owner integer NOT NULL,
    xid text NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    zid integer
);


--
-- Name: xids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xids (
    uid integer NOT NULL,
    owner integer NOT NULL,
    xid text NOT NULL,
    x_profile_image_url character varying(3000),
    x_name character varying(746),
    x_email character varying(256),
    created bigint DEFAULT public.now_as_millis(),
    modified bigint DEFAULT public.now_as_millis() NOT NULL,
    zid integer,
    pid integer
);


--
-- Name: zinvites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zinvites (
    zid integer NOT NULL,
    zinvite character varying(300) NOT NULL,
    created bigint DEFAULT public.now_as_millis(),
    uuid uuid
);


--
-- Name: contexts context_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contexts ALTER COLUMN context_id SET DEFAULT nextval('public.contexts_context_id_seq'::regclass);


--
-- Name: conversations zid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations ALTER COLUMN zid SET DEFAULT nextval('public.conversations_zid_seq'::regclass);


--
-- Name: courses course_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses ALTER COLUMN course_id SET DEFAULT nextval('public.courses_course_id_seq'::regclass);


--
-- Name: participant_metadata_answers pmaid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_answers ALTER COLUMN pmaid SET DEFAULT nextval('public.participant_metadata_answers_pmaid_seq'::regclass);


--
-- Name: participant_metadata_questions pmqid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_questions ALTER COLUMN pmqid SET DEFAULT nextval('public.participant_metadata_questions_pmqid_seq'::regclass);


--
-- Name: reports rid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports ALTER COLUMN rid SET DEFAULT nextval('public.reports_rid_seq'::regclass);


--
-- Name: treevite_invites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites ALTER COLUMN id SET DEFAULT nextval('public.treevite_invites_id_seq'::regclass);


--
-- Name: treevite_login_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes ALTER COLUMN id SET DEFAULT nextval('public.treevite_login_codes_id_seq'::regclass);


--
-- Name: treevite_waves id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_waves ALTER COLUMN id SET DEFAULT nextval('public.treevite_waves_id_seq'::regclass);


--
-- Name: users uid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN uid SET DEFAULT nextval('public.users_uid_seq'::regclass);


--
-- Name: apikeysndvweifu apikeysndvweifu_apikey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apikeysndvweifu
    ADD CONSTRAINT apikeysndvweifu_apikey_key UNIQUE (apikey);


--
-- Name: auth_tokens auth_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_token_key UNIQUE (token);


--
-- Name: beta beta_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta
    ADD CONSTRAINT beta_email_key UNIQUE (email);


--
-- Name: comment_translations comment_translations_zid_tid_src_lang_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_translations
    ADD CONSTRAINT comment_translations_zid_tid_src_lang_key UNIQUE (zid, tid, src, lang);


--
-- Name: comments comments_zid_tid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_zid_tid_key UNIQUE (zid, tid);


--
-- Name: comments comments_zid_txt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_zid_txt_key UNIQUE (zid, txt);


--
-- Name: conversation_translations conversation_translations_zid_src_lang_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_translations
    ADD CONSTRAINT conversation_translations_zid_src_lang_key UNIQUE (zid, src, lang);


--
-- Name: conversations conversations_zid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_zid_key UNIQUE (zid);


--
-- Name: courses courses_course_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_course_id_key UNIQUE (course_id);


--
-- Name: courses courses_course_invite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_course_invite_key UNIQUE (course_invite);


--
-- Name: demographic_data demographic_data_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demographic_data
    ADD CONSTRAINT demographic_data_uid_key UNIQUE (uid);


--
-- Name: einvites einvites_einvite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvites
    ADD CONSTRAINT einvites_einvite_key UNIQUE (einvite);


--
-- Name: email_validations email_validations_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_validations
    ADD CONSTRAINT email_validations_email_key UNIQUE (email);


--
-- Name: facebook_users facebook_users_fb_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facebook_users
    ADD CONSTRAINT facebook_users_fb_user_id_key UNIQUE (fb_user_id);


--
-- Name: facebook_users facebook_users_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facebook_users
    ADD CONSTRAINT facebook_users_uid_key UNIQUE (uid);


--
-- Name: jianiuevyew jianiuevyew_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jianiuevyew
    ADD CONSTRAINT jianiuevyew_uid_key UNIQUE (uid);


--
-- Name: math_bidtopid math_bidtopid_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_bidtopid
    ADD CONSTRAINT math_bidtopid_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_cache math_cache_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_cache
    ADD CONSTRAINT math_cache_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_exportstatus math_exportstatus_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_exportstatus
    ADD CONSTRAINT math_exportstatus_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_main math_main_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_main
    ADD CONSTRAINT math_main_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_profile math_profile_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_profile
    ADD CONSTRAINT math_profile_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_ptptstats math_ptptstats_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_ptptstats
    ADD CONSTRAINT math_ptptstats_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: math_report_correlationmatrix math_report_correlationmatrix_rid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_report_correlationmatrix
    ADD CONSTRAINT math_report_correlationmatrix_rid_math_env_key UNIQUE (rid, math_env);


--
-- Name: math_ticks math_ticks_zid_math_env_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_ticks
    ADD CONSTRAINT math_ticks_zid_math_env_key UNIQUE (zid, math_env);


--
-- Name: notification_tasks notification_tasks_zid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_tasks
    ADD CONSTRAINT notification_tasks_zid_key UNIQUE (zid);


--
-- Name: oidc_user_mappings oidc_user_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_user_mappings
    ADD CONSTRAINT oidc_user_mappings_pkey PRIMARY KEY (oidc_sub);


--
-- Name: oidc_user_mappings oidc_user_mappings_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_user_mappings
    ADD CONSTRAINT oidc_user_mappings_uid_key UNIQUE (uid);


--
-- Name: oinvites oinvites_oinvite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oinvites
    ADD CONSTRAINT oinvites_oinvite_key UNIQUE (oinvite);


--
-- Name: page_ids page_ids_site_id_page_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_ids
    ADD CONSTRAINT page_ids_site_id_page_id_key UNIQUE (site_id, page_id);


--
-- Name: participant_locations participant_locations_zid_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_locations
    ADD CONSTRAINT participant_locations_zid_uid_key UNIQUE (zid, uid);


--
-- Name: participant_metadata_answers participant_metadata_answers_pmaid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_answers
    ADD CONSTRAINT participant_metadata_answers_pmaid_key UNIQUE (pmaid);


--
-- Name: participant_metadata_answers participant_metadata_answers_pmqid_zid_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_answers
    ADD CONSTRAINT participant_metadata_answers_pmqid_zid_value_key UNIQUE (pmqid, zid, value);


--
-- Name: participant_metadata_choices participant_metadata_choices_zid_pid_pmqid_pmaid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_choices
    ADD CONSTRAINT participant_metadata_choices_zid_pid_pmqid_pmaid_key UNIQUE (zid, pid, pmqid, pmaid);


--
-- Name: participant_metadata_questions participant_metadata_questions_pmqid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_questions
    ADD CONSTRAINT participant_metadata_questions_pmqid_key UNIQUE (pmqid);


--
-- Name: participant_metadata_questions participant_metadata_questions_zid_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_questions
    ADD CONSTRAINT participant_metadata_questions_zid_key_key UNIQUE (zid, key);


--
-- Name: participants_extended participants_extended_zid_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants_extended
    ADD CONSTRAINT participants_extended_zid_uid_key UNIQUE (zid, uid);


--
-- Name: participants participants_zid_pid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_zid_pid_key UNIQUE (zid, pid);


--
-- Name: participants participants_zid_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_zid_uid_key UNIQUE (zid, uid);


--
-- Name: pwreset_tokens password_reset_tokens_pwresettoken_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwreset_tokens
    ADD CONSTRAINT password_reset_tokens_pwresettoken_key UNIQUE (token);


--
-- Name: password_reset_tokens password_reset_tokens_pwresettoken_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pwresettoken_key1 UNIQUE (token);


--
-- Name: permanentcookiezidjoins permanentcookiezidjoins_zid_cookie_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permanentcookiezidjoins
    ADD CONSTRAINT permanentcookiezidjoins_zid_cookie_key UNIQUE (zid, cookie);


--
-- Name: report_comment_selections report_comment_selections_rid_tid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_comment_selections
    ADD CONSTRAINT report_comment_selections_rid_tid_key UNIQUE (rid, tid);


--
-- Name: reports reports_report_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_report_id_key UNIQUE (report_id);


--
-- Name: reports reports_rid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_rid_key UNIQUE (rid);


--
-- Name: suzinvites suzinvites_suzinvite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suzinvites
    ADD CONSTRAINT suzinvites_suzinvite_key UNIQUE (suzinvite);


--
-- Name: topic_agenda_selections topic_agenda_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_agenda_selections
    ADD CONSTRAINT topic_agenda_selections_pkey PRIMARY KEY (zid, pid);


--
-- Name: treevite_invites treevite_invites_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_code_unique UNIQUE (zid, invite_code);


--
-- Name: treevite_invites treevite_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_pkey PRIMARY KEY (id);


--
-- Name: treevite_login_codes treevite_login_codes_fp_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes
    ADD CONSTRAINT treevite_login_codes_fp_unique UNIQUE (zid, login_code_fingerprint);


--
-- Name: treevite_login_codes treevite_login_codes_lookup_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes
    ADD CONSTRAINT treevite_login_codes_lookup_unique UNIQUE (zid, login_code_lookup);


--
-- Name: treevite_login_codes treevite_login_codes_pid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes
    ADD CONSTRAINT treevite_login_codes_pid_unique UNIQUE (zid, pid);


--
-- Name: treevite_login_codes treevite_login_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes
    ADD CONSTRAINT treevite_login_codes_pkey PRIMARY KEY (id);


--
-- Name: treevite_waves treevite_waves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_waves
    ADD CONSTRAINT treevite_waves_pkey PRIMARY KEY (id);


--
-- Name: treevite_waves treevite_waves_zid_wave_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_waves
    ADD CONSTRAINT treevite_waves_zid_wave_key UNIQUE (zid, wave);


--
-- Name: twitter_users twitter_users_twitter_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twitter_users
    ADD CONSTRAINT twitter_users_twitter_user_id_key UNIQUE (twitter_user_id);


--
-- Name: twitter_users twitter_users_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twitter_users
    ADD CONSTRAINT twitter_users_uid_key UNIQUE (uid);


--
-- Name: upvotes upvotes_uid_zid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upvotes
    ADD CONSTRAINT upvotes_uid_zid_key UNIQUE (uid, zid);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_uid_key UNIQUE (uid);


--
-- Name: votes_latest_unique votes_latest_unique_zid_pid_tid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes_latest_unique
    ADD CONSTRAINT votes_latest_unique_zid_pid_tid_key UNIQUE (zid, pid, tid);


--
-- Name: xid_whitelist xid_whitelist_owner_xid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xid_whitelist
    ADD CONSTRAINT xid_whitelist_owner_xid_key UNIQUE (owner, xid);


--
-- Name: xids xids_owner_xid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xids
    ADD CONSTRAINT xids_owner_xid_key UNIQUE (owner, xid);


--
-- Name: zinvites zinvites_zinvite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zinvites
    ADD CONSTRAINT zinvites_zinvite_key UNIQUE (zinvite);


--
-- Name: apikeysndvweifu_apikey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apikeysndvweifu_apikey_idx ON public.apikeysndvweifu USING btree (apikey);


--
-- Name: apikeysndvweifu_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apikeysndvweifu_uid_idx ON public.apikeysndvweifu USING btree (uid);


--
-- Name: comment_translations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comment_translations_idx ON public.comment_translations USING btree (zid, tid);


--
-- Name: comments_zid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_zid_idx ON public.comments USING btree (zid);


--
-- Name: conversation_translations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_translations_idx ON public.conversation_translations USING btree (zid);


--
-- Name: conversations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_owner_idx ON public.conversations USING btree (owner);


--
-- Name: course_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX course_id_idx ON public.courses USING btree (course_id);


--
-- Name: idx_oidc_mappings_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oidc_mappings_uid ON public.oidc_user_mappings USING btree (uid);


--
-- Name: idx_topic_agenda_selections_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_topic_agenda_selections_created_at ON public.topic_agenda_selections USING btree (created_at);


--
-- Name: idx_topic_agenda_selections_delphi_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_topic_agenda_selections_delphi_job_id ON public.topic_agenda_selections USING btree (delphi_job_id);


--
-- Name: idx_topic_agenda_selections_pid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_topic_agenda_selections_pid ON public.topic_agenda_selections USING btree (pid);


--
-- Name: idx_topic_agenda_selections_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_topic_agenda_selections_zid ON public.topic_agenda_selections USING btree (zid);


--
-- Name: idx_treevite_invites_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_code ON public.treevite_invites USING btree (invite_code);


--
-- Name: idx_treevite_invites_owner_pid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_owner_pid ON public.treevite_invites USING btree (invite_owner_pid);


--
-- Name: idx_treevite_invites_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_parent ON public.treevite_invites USING btree (parent_invite_id);


--
-- Name: idx_treevite_invites_used_by_pid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_used_by_pid ON public.treevite_invites USING btree (invite_used_by_pid);


--
-- Name: idx_treevite_invites_wave_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_wave_id ON public.treevite_invites USING btree (wave_id);


--
-- Name: idx_treevite_invites_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_zid ON public.treevite_invites USING btree (zid);


--
-- Name: idx_treevite_invites_zid_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_invites_zid_status ON public.treevite_invites USING btree (zid, status);


--
-- Name: idx_treevite_login_codes_fp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_login_codes_fp ON public.treevite_login_codes USING btree (login_code_fingerprint);


--
-- Name: idx_treevite_login_codes_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_login_codes_lookup ON public.treevite_login_codes USING btree (zid, login_code_lookup);


--
-- Name: idx_treevite_login_codes_pid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_login_codes_pid ON public.treevite_login_codes USING btree (pid);


--
-- Name: idx_treevite_login_codes_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_login_codes_zid ON public.treevite_login_codes USING btree (zid);


--
-- Name: idx_treevite_waves_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_waves_parent ON public.treevite_waves USING btree (zid, parent_wave);


--
-- Name: idx_treevite_waves_wave; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_waves_wave ON public.treevite_waves USING btree (wave);


--
-- Name: idx_treevite_waves_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_treevite_waves_zid ON public.treevite_waves USING btree (zid);


--
-- Name: idx_xid_whitelist_xid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xid_whitelist_xid ON public.xid_whitelist USING btree (xid);


--
-- Name: idx_xid_whitelist_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xid_whitelist_zid ON public.xid_whitelist USING btree (zid);


--
-- Name: idx_xids_pid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xids_pid ON public.xids USING btree (pid);


--
-- Name: idx_xids_uid_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xids_uid_zid ON public.xids USING btree (uid, zid);


--
-- Name: idx_xids_xid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xids_xid ON public.xids USING btree (xid);


--
-- Name: idx_xids_zid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xids_zid ON public.xids USING btree (zid);


--
-- Name: idx_xids_zid_xid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_xids_zid_xid ON public.xids USING btree (zid, xid);


--
-- Name: main_main_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX main_main_idx ON public.math_main USING btree (zid);


--
-- Name: main_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX main_profile_idx ON public.math_profile USING btree (zid);


--
-- Name: math_bidtopid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX math_bidtopid_idx ON public.math_bidtopid USING btree (zid);


--
-- Name: math_cache_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX math_cache_idx ON public.math_cache USING btree (zid);


--
-- Name: math_exportstatus_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX math_exportstatus_idx ON public.math_exportstatus USING btree (zid);


--
-- Name: math_math_report_correlationmatrix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX math_math_report_correlationmatrix_idx ON public.math_report_correlationmatrix USING btree (rid);


--
-- Name: math_ptptstats_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX math_ptptstats_idx ON public.math_ptptstats USING btree (zid);


--
-- Name: participants_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX participants_conv_idx ON public.participants USING btree (zid);


--
-- Name: participants_conv_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX participants_conv_uid_idx ON public.participants USING btree (uid);


--
-- Name: site_domain_whitelist_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX site_domain_whitelist_idx ON public.users USING btree (site_id);


--
-- Name: suzinvites_owner_zid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX suzinvites_owner_zid_idx ON public.suzinvites USING btree (owner, zid);


--
-- Name: users_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_uid_idx ON public.users USING btree (uid);


--
-- Name: votes_latest_unique_zid_tid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX votes_latest_unique_zid_tid_idx ON public.votes USING btree (zid, tid);


--
-- Name: votes_zid_pid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX votes_zid_pid_idx ON public.votes USING btree (zid, pid);


--
-- Name: xid_whitelist_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX xid_whitelist_owner_idx ON public.xid_whitelist USING btree (owner);


--
-- Name: xids_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX xids_owner_idx ON public.xids USING btree (owner);


--
-- Name: zinvites_zid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX zinvites_zid_idx ON public.zinvites USING btree (zid);


--
-- Name: votes on_vote_insert_update_unique_table; Type: RULE; Schema: public; Owner: -
--

CREATE RULE on_vote_insert_update_unique_table AS
    ON INSERT TO public.votes DO  INSERT INTO public.votes_latest_unique (zid, pid, tid, vote, weight_x_32767, modified)
  VALUES (new.zid, new.pid, new.tid, new.vote, new.weight_x_32767, new.created) ON CONFLICT(zid, pid, tid) DO UPDATE SET vote = excluded.vote, modified = excluded.modified;


--
-- Name: participants pid_auto; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pid_auto BEFORE INSERT ON public.participants FOR EACH ROW EXECUTE FUNCTION public.pid_auto();


--
-- Name: participants pid_auto_unlock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pid_auto_unlock AFTER INSERT ON public.participants FOR EACH ROW EXECUTE FUNCTION public.pid_auto_unlock();


--
-- Name: comments tid_auto; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tid_auto BEFORE INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.tid_auto();


--
-- Name: comments tid_auto_unlock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tid_auto_unlock AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.tid_auto_unlock();


--
-- Name: apikeysndvweifu apikeysndvweifu_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apikeysndvweifu
    ADD CONSTRAINT apikeysndvweifu_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: auth_tokens auth_tokens_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: comment_translations comment_translations_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_translations
    ADD CONSTRAINT comment_translations_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: comments comments_zid_pid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_zid_pid_fkey FOREIGN KEY (zid, pid) REFERENCES public.participants(zid, pid);


--
-- Name: contexts contexts_creator_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contexts
    ADD CONSTRAINT contexts_creator_fkey FOREIGN KEY (creator) REFERENCES public.users(uid);


--
-- Name: contributer_agreement_signatures contributer_agreement_signatures_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributer_agreement_signatures
    ADD CONSTRAINT contributer_agreement_signatures_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: conversation_translations conversation_translations_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_translations
    ADD CONSTRAINT conversation_translations_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: conversations conversations_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(course_id);


--
-- Name: conversations conversations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.users(uid);


--
-- Name: conversations conversations_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(uid);


--
-- Name: courses courses_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(uid);


--
-- Name: demographic_data demographic_data_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demographic_data
    ADD CONSTRAINT demographic_data_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: facebook_friends facebook_friends_friend_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facebook_friends
    ADD CONSTRAINT facebook_friends_friend_fkey FOREIGN KEY (friend) REFERENCES public.users(uid);


--
-- Name: facebook_friends facebook_friends_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facebook_friends
    ADD CONSTRAINT facebook_friends_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: facebook_users facebook_users_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facebook_users
    ADD CONSTRAINT facebook_users_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: topic_agenda_selections fk_conversation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_agenda_selections
    ADD CONSTRAINT fk_conversation FOREIGN KEY (zid) REFERENCES public.conversations(zid) ON DELETE CASCADE;


--
-- Name: topic_agenda_selections fk_participant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_agenda_selections
    ADD CONSTRAINT fk_participant FOREIGN KEY (zid, pid) REFERENCES public.participants(zid, pid) ON DELETE CASCADE;


--
-- Name: inviters inviters_inviter_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inviters
    ADD CONSTRAINT inviters_inviter_uid_fkey FOREIGN KEY (inviter_uid) REFERENCES public.users(uid);


--
-- Name: jianiuevyew jianiuevyew_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jianiuevyew
    ADD CONSTRAINT jianiuevyew_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: math_bidtopid math_bidtopid_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_bidtopid
    ADD CONSTRAINT math_bidtopid_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_cache math_cache_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_cache
    ADD CONSTRAINT math_cache_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_exportstatus math_exportstatus_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_exportstatus
    ADD CONSTRAINT math_exportstatus_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_main math_main_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_main
    ADD CONSTRAINT math_main_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_profile math_profile_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_profile
    ADD CONSTRAINT math_profile_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_ptptstats math_ptptstats_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_ptptstats
    ADD CONSTRAINT math_ptptstats_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: math_report_correlationmatrix math_report_correlationmatrix_rid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_report_correlationmatrix
    ADD CONSTRAINT math_report_correlationmatrix_rid_fkey FOREIGN KEY (rid) REFERENCES public.reports(rid);


--
-- Name: math_ticks math_ticks_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.math_ticks
    ADD CONSTRAINT math_ticks_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: metrics metrics_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics
    ADD CONSTRAINT metrics_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: notification_tasks notification_tasks_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_tasks
    ADD CONSTRAINT notification_tasks_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: oidc_user_mappings oidc_user_mappings_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_user_mappings
    ADD CONSTRAINT oidc_user_mappings_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: page_ids page_ids_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_ids
    ADD CONSTRAINT page_ids_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: participant_locations participant_locations_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_locations
    ADD CONSTRAINT participant_locations_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: participant_locations participant_locations_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_locations
    ADD CONSTRAINT participant_locations_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: participant_metadata_answers participant_metadata_answers_pmqid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_answers
    ADD CONSTRAINT participant_metadata_answers_pmqid_fkey FOREIGN KEY (pmqid) REFERENCES public.participant_metadata_questions(pmqid);


--
-- Name: participant_metadata_answers participant_metadata_answers_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_answers
    ADD CONSTRAINT participant_metadata_answers_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: participant_metadata_choices participant_metadata_choices_pmaid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_choices
    ADD CONSTRAINT participant_metadata_choices_pmaid_fkey FOREIGN KEY (pmaid) REFERENCES public.participant_metadata_answers(pmaid);


--
-- Name: participant_metadata_choices participant_metadata_choices_pmqid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_choices
    ADD CONSTRAINT participant_metadata_choices_pmqid_fkey FOREIGN KEY (pmqid) REFERENCES public.participant_metadata_questions(pmqid);


--
-- Name: participant_metadata_choices participant_metadata_choices_zid_pid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_choices
    ADD CONSTRAINT participant_metadata_choices_zid_pid_fkey FOREIGN KEY (zid, pid) REFERENCES public.participants(zid, pid);


--
-- Name: participant_metadata_questions participant_metadata_questions_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participant_metadata_questions
    ADD CONSTRAINT participant_metadata_questions_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: participants_extended participants_extended_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants_extended
    ADD CONSTRAINT participants_extended_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: participants_extended participants_extended_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants_extended
    ADD CONSTRAINT participants_extended_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: participants participants_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: participants participants_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: pwreset_tokens password_reset_tokens_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwreset_tokens
    ADD CONSTRAINT password_reset_tokens_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: password_reset_tokens password_reset_tokens_uid_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_uid_fkey1 FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: report_comment_selections report_comment_selections_rid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_comment_selections
    ADD CONSTRAINT report_comment_selections_rid_fkey FOREIGN KEY (rid) REFERENCES public.reports(rid);


--
-- Name: report_comment_selections report_comment_selections_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_comment_selections
    ADD CONSTRAINT report_comment_selections_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: reports reports_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: social_settings social_settings_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_settings
    ADD CONSTRAINT social_settings_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: suzinvites suzinvites_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suzinvites
    ADD CONSTRAINT suzinvites_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(uid);


--
-- Name: suzinvites suzinvites_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suzinvites
    ADD CONSTRAINT suzinvites_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: treevite_invites treevite_invites_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_owner_fkey FOREIGN KEY (zid, invite_owner_pid) REFERENCES public.participants(zid, pid);


--
-- Name: treevite_invites treevite_invites_parent_invite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_parent_invite_id_fkey FOREIGN KEY (parent_invite_id) REFERENCES public.treevite_invites(id) ON DELETE SET NULL;


--
-- Name: treevite_invites treevite_invites_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_used_by_fkey FOREIGN KEY (zid, invite_used_by_pid) REFERENCES public.participants(zid, pid);


--
-- Name: treevite_invites treevite_invites_wave_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_wave_id_fkey FOREIGN KEY (wave_id) REFERENCES public.treevite_waves(id) ON DELETE CASCADE;


--
-- Name: treevite_invites treevite_invites_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_invites
    ADD CONSTRAINT treevite_invites_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid) ON DELETE CASCADE;


--
-- Name: treevite_login_codes treevite_login_codes_participant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_login_codes
    ADD CONSTRAINT treevite_login_codes_participant_fkey FOREIGN KEY (zid, pid) REFERENCES public.participants(zid, pid) ON DELETE CASCADE;


--
-- Name: treevite_waves treevite_waves_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treevite_waves
    ADD CONSTRAINT treevite_waves_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid) ON DELETE CASCADE;


--
-- Name: twitter_users twitter_users_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twitter_users
    ADD CONSTRAINT twitter_users_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: upvotes upvotes_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upvotes
    ADD CONSTRAINT upvotes_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: upvotes upvotes_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upvotes
    ADD CONSTRAINT upvotes_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- Name: xid_whitelist xid_whitelist_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xid_whitelist
    ADD CONSTRAINT xid_whitelist_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(uid);


--
-- Name: xid_whitelist xid_whitelist_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xid_whitelist
    ADD CONSTRAINT xid_whitelist_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid) ON DELETE CASCADE;


--
-- Name: xids xids_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xids
    ADD CONSTRAINT xids_owner_fkey FOREIGN KEY (owner) REFERENCES public.users(uid);


--
-- Name: xids xids_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xids
    ADD CONSTRAINT xids_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: xids xids_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xids
    ADD CONSTRAINT xids_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid) ON DELETE CASCADE;


--
-- Name: zinvites zinvites_zid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zinvites
    ADD CONSTRAINT zinvites_zid_fkey FOREIGN KEY (zid) REFERENCES public.conversations(zid);


--
-- PostgreSQL database dump complete
--

\unrestrict ZuTT5v8YTYzMtKWq70d0gkNuGdRU0paPlHKUMtzblcYz2cIg5JJ8HVGULeAI8MJ

