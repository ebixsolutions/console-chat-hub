import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { conversation_id } = await req.json();
    if (!conversation_id) {
      return new Response(JSON.stringify({ error: 'conversation_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, status')
      .eq('id', conversation_id)
      .single();

    if (convError || !conversation) {
      console.error('[generate-reply] conversation not found:', conversation_id);
      return new Response(JSON.stringify({ error: 'Conversation not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (conversation.status === 'resolved') {
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ success: true, skipped: 'resolved' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: messages } = await supabaseAdmin
      .from('messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversation_id)
      .neq('content', '__THINKING__')
      .eq('is_recalled', false)
      .order('created_at', { ascending: true })
      .limit(10);

    if (!messages || messages.length === 0) {
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ success: true, skipped: 'no messages' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const claudeMessages = messages.map(m => ({
      role: (m.role === 'visitor') ? 'user' : 'assistant',
      content: m.content
    }));

    if (claudeMessages[claudeMessages.length - 1].role === 'assistant') {
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ success: true, skipped: 'last message is assistant' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      console.error('[generate-reply] ANTHROPIC_API_KEY not set');
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ error: 'AI service not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: `You are a professional and friendly customer service assistant. 
Answer customer questions clearly and concisely. 
If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.
Keep responses under 150 words.
Respond in the same language the customer is using.`,
        messages: claudeMessages
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('[generate-reply] Claude API error:', claudeResponse.status, errText);
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ error: 'AI service error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const claudeData = await claudeResponse.json();
    const aiReplyContent = claudeData.content?.[0]?.text ?? '';

    if (!aiReplyContent) {
      await supabaseAdmin
        .from('conversations')
        .update({ ai_generating: false })
        .eq('id', conversation_id);
      return new Response(JSON.stringify({ error: 'Empty AI response' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await supabaseAdmin
      .from('messages')
      .delete()
      .eq('conversation_id', conversation_id)
      .eq('content', '__THINKING__');

    const { error: insertError } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: conversation_id,
        role: 'assistant',
        content: aiReplyContent,
        status: 'delivered',
        is_recalled: false
      });

    if (insertError) {
      console.error('[generate-reply] insert error:', insertError);
    }

    await supabaseAdmin
      .from('conversations')
      .update({
        ai_generating: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation_id);

    console.log('[generate-reply] AI reply sent for conversation:', conversation_id);
    return new Response(JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[generate-reply] unexpected error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
