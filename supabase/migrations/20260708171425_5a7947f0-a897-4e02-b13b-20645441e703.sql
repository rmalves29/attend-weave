-- Corrige nomes de contatos que foram salvos com o nome do dono da conta ("Rafael Alves")
-- em vez do nome real do cliente. Reseta para o telefone; próximas mensagens inbound
-- atualizarão automaticamente com o pushName correto.
UPDATE public.contacts
SET name = phone
WHERE name ILIKE '%Rafael Alves%'
  AND phone IS NOT NULL;