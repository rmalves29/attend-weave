export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bot_menu_options: {
        Row: {
          action_type: string
          assign_agent_id: string | null
          assign_tag_id: string | null
          created_at: string
          id: string
          keyword: string
          label: string
          position: number
          response_text: string | null
          updated_at: string
        }
        Insert: {
          action_type?: string
          assign_agent_id?: string | null
          assign_tag_id?: string | null
          created_at?: string
          id?: string
          keyword: string
          label: string
          position?: number
          response_text?: string | null
          updated_at?: string
        }
        Update: {
          action_type?: string
          assign_agent_id?: string | null
          assign_tag_id?: string | null
          created_at?: string
          id?: string
          keyword?: string
          label?: string
          position?: number
          response_text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_menu_options_assign_tag_id_fkey"
            columns: ["assign_tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_settings: {
        Row: {
          enabled: boolean
          finalize_after_days: number
          id: number
          updated_at: string
          welcome_text: string
        }
        Insert: {
          enabled?: boolean
          finalize_after_days?: number
          id?: number
          updated_at?: string
          welcome_text?: string
        }
        Update: {
          enabled?: boolean
          finalize_after_days?: number
          id?: number
          updated_at?: string
          welcome_text?: string
        }
        Relationships: []
      }
      channels: {
        Row: {
          created_at: string
          credentials: Json | null
          id: string
          identifier: string | null
          last_connected_at: string | null
          name: string
          qr_code: string | null
          status: Database["public"]["Enums"]["channel_status"]
          type: Database["public"]["Enums"]["channel_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          credentials?: Json | null
          id?: string
          identifier?: string | null
          last_connected_at?: string | null
          name: string
          qr_code?: string | null
          status?: Database["public"]["Enums"]["channel_status"]
          type: Database["public"]["Enums"]["channel_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          credentials?: Json | null
          id?: string
          identifier?: string | null
          last_connected_at?: string | null
          name?: string
          qr_code?: string | null
          status?: Database["public"]["Enums"]["channel_status"]
          type?: Database["public"]["Enums"]["channel_type"]
          updated_at?: string
        }
        Relationships: []
      }
      contacts: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          external_id: string | null
          id: string
          metadata: Json | null
          name: string
          phone: string | null
          source_channel_id: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          name: string
          phone?: string | null
          source_channel_id?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          phone?: string | null
          source_channel_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_source_channel_id_fkey"
            columns: ["source_channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_agent_id: string | null
          bot_active: boolean
          channel_id: string
          contact_id: string
          created_at: string
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["conversation_status"]
          tags: string[] | null
          unread_count: number
          updated_at: string
        }
        Insert: {
          assigned_agent_id?: string | null
          bot_active?: boolean
          channel_id: string
          contact_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["conversation_status"]
          tags?: string[] | null
          unread_count?: number
          updated_at?: string
        }
        Update: {
          assigned_agent_id?: string | null
          bot_active?: boolean
          channel_id?: string
          contact_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["conversation_status"]
          tags?: string[] | null
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string | null
          conversation_id: string
          created_at: string
          direction: Database["public"]["Enums"]["message_direction"]
          external_id: string | null
          id: string
          is_internal: boolean
          media_url: string | null
          metadata: Json | null
          sender_agent_id: string | null
          status: Database["public"]["Enums"]["message_status"]
          type: Database["public"]["Enums"]["message_type"]
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["message_direction"]
          external_id?: string | null
          id?: string
          is_internal?: boolean
          media_url?: string | null
          metadata?: Json | null
          sender_agent_id?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          type?: Database["public"]["Enums"]["message_type"]
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["message_direction"]
          external_id?: string | null
          id?: string
          is_internal?: boolean
          media_url?: string | null
          metadata?: Json | null
          sender_agent_id?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          type?: Database["public"]["Enums"]["message_type"]
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          id: string
          name: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      quick_replies: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          shortcut: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          shortcut: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          shortcut?: string
          updated_at?: string
        }
        Relationships: []
      }
      tag_followups: {
        Row: {
          conversation_id: string
          created_at: string
          error: string | null
          id: string
          send_at: string
          sent_at: string | null
          status: string
          tag_id: string
          updated_at: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          error?: string | null
          id?: string
          send_at: string
          sent_at?: string | null
          status?: string
          tag_id: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          error?: string | null
          id?: string
          send_at?: string
          sent_at?: string | null
          status?: string
          tag_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tag_followups_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tag_followups_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          auto_message_at: string | null
          auto_message_content: string | null
          auto_message_enabled: boolean
          auto_message_hours: number
          auto_message_mode: string
          auto_message_unit: string
          auto_message_value: number
          created_at: string
          id: string
          name: string
          sets_status: string | null
          updated_at: string
        }
        Insert: {
          auto_message_at?: string | null
          auto_message_content?: string | null
          auto_message_enabled?: boolean
          auto_message_hours?: number
          auto_message_mode?: string
          auto_message_unit?: string
          auto_message_value?: number
          created_at?: string
          id?: string
          name: string
          sets_status?: string | null
          updated_at?: string
        }
        Update: {
          auto_message_at?: string | null
          auto_message_content?: string | null
          auto_message_enabled?: boolean
          auto_message_hours?: number
          auto_message_mode?: string
          auto_message_unit?: string
          auto_message_value?: number
          created_at?: string
          id?: string
          name?: string
          sets_status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      report_agent_performance: {
        Args: { _since: string }
        Returns: {
          agent_id: string
          agent_name: string
          avg_first_response_secs: number
          conversations_attended: number
          messages_sent: number
          resolved_count: number
        }[]
      }
      report_agent_performance_v2: {
        Args: { _channel_ids?: string[]; _since: string; _until: string }
        Returns: {
          agent_id: string
          agent_name: string
          aht_secs: number
          avg_first_response_secs: number
          concurrent_avg: number
          concurrent_peak: number
          conversations_attended: number
          first_contact_resolution_count: number
          messages_sent: number
          resolved_count: number
        }[]
      }
      report_channel_breakdown: {
        Args: { _since: string; _until: string }
        Returns: {
          avg_first_response_secs: number
          channel_id: string
          channel_name: string
          channel_type: string
          conversations_count: number
          inbound_count: number
          outbound_count: number
        }[]
      }
      report_daily_flow: {
        Args: { _since: string }
        Returns: {
          day: string
          inbound: number
          outbound: number
        }[]
      }
      report_daily_flow_v2: {
        Args: { _channel_ids?: string[]; _since: string; _until: string }
        Returns: {
          day: string
          inbound: number
          outbound: number
        }[]
      }
      report_followups_summary: {
        Args: { _since: string; _until: string }
        Returns: {
          cancelled_count: number
          failed_count: number
          scheduled_count: number
          sent_count: number
          upcoming: Json
        }[]
      }
      report_hourly_heatmap: {
        Args: { _channel_ids?: string[]; _since: string; _until: string }
        Returns: {
          dow: number
          hour: number
          inbound: number
        }[]
      }
      report_overview: {
        Args: { _since: string }
        Returns: {
          avg_first_response_secs: number
          avg_resolution_secs: number
          contacts_new: number
          conversations_active: number
          conversations_new: number
          conversations_open_now: number
          conversations_resolved: number
          inbound_count: number
          outbound_count: number
        }[]
      }
      report_overview_v2: {
        Args: { _channel_ids?: string[]; _since: string; _until: string }
        Returns: {
          avg_first_response_secs: number
          avg_resolution_secs: number
          contacts_new: number
          conversations_active: number
          conversations_new: number
          conversations_open_now: number
          conversations_resolved: number
          inbound_count: number
          oldest_open_secs: number
          outbound_count: number
          p50_first_response_secs: number
          p50_resolution_secs: number
          p90_first_response_secs: number
          p90_resolution_secs: number
          p95_first_response_secs: number
          p95_resolution_secs: number
          sla_15m_count: number
          sla_1h_count: number
          sla_5m_count: number
          sla_total_count: number
        }[]
      }
      report_top_tags: {
        Args: {
          _channel_ids?: string[]
          _limit?: number
          _since: string
          _until: string
        }
        Returns: {
          conversations_count: number
          tag_name: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "agent"
      channel_status: "connected" | "disconnected" | "connecting" | "error"
      channel_type: "whatsapp" | "instagram" | "facebook"
      conversation_status: "open" | "pending" | "resolved" | "closed"
      message_direction: "inbound" | "outbound"
      message_status: "pending" | "sent" | "delivered" | "read" | "failed"
      message_type:
        | "text"
        | "image"
        | "video"
        | "audio"
        | "document"
        | "sticker"
        | "location"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "agent"],
      channel_status: ["connected", "disconnected", "connecting", "error"],
      channel_type: ["whatsapp", "instagram", "facebook"],
      conversation_status: ["open", "pending", "resolved", "closed"],
      message_direction: ["inbound", "outbound"],
      message_status: ["pending", "sent", "delivered", "read", "failed"],
      message_type: [
        "text",
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
      ],
    },
  },
} as const
